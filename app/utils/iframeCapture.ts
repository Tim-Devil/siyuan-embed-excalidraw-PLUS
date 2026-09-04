import { snapdom } from '@zumer/snapdom';
import { processArraySequentially } from '../../src/utils/task';
import CryptoJS from 'crypto-js';

/**
 * 判断元素是否需要 iframe 捕获处理
 * 目前支持：思源块嵌入、Markdown 元素
 */
export function needsIframeCapture(element: any): boolean {
  // Markdown 元素
  if (element?.type === "embeddable" && element?.customData?.embedMarkdown) return true;

  // 思源块嵌入（通过 link 判断）
  if (element?.type === "embeddable" && element?.link?.startsWith('siyuan://blocks/')) return true;

  return false;
}

/**
 * 获取 iframe 元素
 */
export function getIframeForElement(element: any): HTMLIFrameElement | null {
  let expectedURL: URL;

  // Markdown 元素
  if (element?.customData?.embedMarkdown) {
    const src = `/plugins/siyuan-embed-excalidraw-plus/embed/markdown/?elementId=${element.id}`;
    expectedURL = new URL(src, window.location.origin);
  } else if (element?.link?.startsWith('siyuan://blocks/')) {
    // 思源块嵌入（通过 link 中的 blockId 查找）
    const blockId = element.link.split('siyuan://blocks/')[1];
    const src = `/plugins/siyuan-embed-excalidraw-plus/embed/siyuan/?elementId=${element.id}&blockId=${blockId}`;
    expectedURL = new URL(src, window.location.origin);
  } else {
    return null;
  }

  return Array.from(
    document.querySelectorAll<HTMLIFrameElement>('iframe.excalidraw__embeddable'),
  ).find((iframe) => {
    try {
      const actualURL = new URL(
        iframe.getAttribute('src') || iframe.src,
        window.location.href,
      );
      return (
        actualURL.origin === expectedURL.origin &&
        actualURL.pathname === expectedURL.pathname &&
        actualURL.searchParams.get('elementId') ===
          expectedURL.searchParams.get('elementId') &&
        actualURL.searchParams.get('blockId') ===
          expectedURL.searchParams.get('blockId')
      );
    } catch (error) {
      return false;
    }
  }) || null;
}

export const getIframeVersionNonce = (element: any): number => {
  const customNonce = element?.customData?.embedIframeVersionNonce;
  if (Number.isFinite(customNonce)) return customNonce;

  return Number.isFinite(element?.versionNonce) ? element.versionNonce : 0;
};

export const hasCurrentIframeCache = (
  element: any,
  cache: IframeCache | undefined,
): boolean => Boolean(
  cache?.dataURL &&
  cache.embedIframeVersionNonce === getIframeVersionNonce(element) &&
  cache.width === element.width &&
  cache.height === element.height,
);

const isStoredIframeCache = (value: unknown): value is IframeCache => {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<IframeCache>;
  return typeof cache.dataURL === 'string'
    && cache.dataURL.startsWith('data:')
    && Number.isFinite(cache.embedIframeVersionNonce)
    && Number.isFinite(cache.width)
    && cache.width > 0
    && Number.isFinite(cache.height)
    && cache.height > 0;
};

export const hasCompleteIframeCache = (
  elements: any[],
  iframeCacheMap: Map<string, IframeCache>,
): boolean => elements
  .filter(needsIframeCapture)
  .every((element) => hasCurrentIframeCache(element, iframeCacheMap.get(element.id)));

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeout = 0;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
};

const waitForIframeLoad = (
  iframe: HTMLIFrameElement,
  timeoutMs = 10000,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    let timeout = 0;
    let expectedURL: URL | null = null;
    try {
      const source = iframe.getAttribute('src') || iframe.src;
      if (source) expectedURL = new URL(source, window.location.href);
    } catch (error) {
      expectedURL = null;
    }
    const isReady = () => {
      if (!iframe.isConnected) return false;
      try {
        const frameDocument = iframe.contentDocument;
        if (!frameDocument?.body || frameDocument.readyState !== 'complete') {
          return false;
        }
        if (!frameDocument.URL || frameDocument.URL === 'about:blank') {
          return false;
        }
        if (!expectedURL) return true;

        const loadedURL = new URL(frameDocument.URL, window.location.href);
        return (
          loadedURL.origin === expectedURL.origin &&
          loadedURL.pathname === expectedURL.pathname &&
          loadedURL.searchParams.get('elementId') ===
            expectedURL.searchParams.get('elementId') &&
          loadedURL.searchParams.get('blockId') ===
            expectedURL.searchParams.get('blockId')
        );
      } catch (error) {
        return false;
      }
    };
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
      resolve(loaded);
    };
    const onLoad = () => {
      if (isReady()) finish(true);
    };
    const onError = () => finish(false);
    timeout = window.setTimeout(() => finish(false), timeoutMs);

    // A newly-created iframe can emit an about:blank load before its real URL.
    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', onError, { once: true });
    if (isReady()) finish(true);
  });

type IframeWindow = Window & {
  __EXCALIDRAW_PLUS_FLUSH_PENDING_INPUT__?: () => void;
};

const flushIframePendingInput = async (
  iframe: HTMLIFrameElement,
): Promise<void> => {
  let frameWindow: IframeWindow | null = null;
  try {
    frameWindow = iframe.contentWindow as IframeWindow | null;
    const flush = frameWindow?.__EXCALIDRAW_PLUS_FLUSH_PENDING_INPUT__;
    if (typeof flush !== 'function') return;

    await withTimeout(
      Promise.resolve().then(() => flush.call(frameWindow)),
      1000,
      'iframe pending input flush timeout',
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  } catch (error) {
    console.warn('Failed to flush iframe input', error);
  }
};

/** Flush editor input before a raster save so the iframe nonce and cache key are current. */
export async function flushAllIframeEdits(elements: any[]): Promise<void> {
  const elementsToFlush = elements.filter(needsIframeCapture);
  await processArraySequentially(elementsToFlush, async (element) => {
    const iframe = getIframeForElement(element);
    // Give already-mounted frames a short preflush window. The capture pass
    // performs the full wait for frames that are still mounting.
    if (!iframe || !(await waitForIframeLoad(iframe, 1000))) return;
    await flushIframePendingInput(iframe);
  });
}

/**
 * 捕获 iframe 并转换为 SVG 字符串
 */
export async function captureIframe(
  iframe: HTMLIFrameElement
): Promise<string | null> {
  try {
    if (!iframe.contentDocument?.body) return null;
    const width = iframe.clientWidth;
    const height = iframe.clientHeight;
    if (width <= 0 || height <= 0) return null;
    const img = await withTimeout(
      snapdom.toSvg(iframe.contentDocument.body, {
        width,
        height,
        scale: 1,
        embedFonts: true,
      }),
      15000,
      'iframe capture timeout',
    );
    return img.src;
  } catch (error) {
    console.error('Failed to capture iframe:', error);
    return null;
  }
}

/**
 * 为所有需要处理的元素捕获 iframe
 */
export async function captureAllIframes(
  elements: any[],
  iframeCacheMap: Map<string, IframeCache>,
): Promise<Map<string, IframeCache>> {
  const elementsToCapture = elements.filter(needsIframeCapture);
  const newIframeCacheMap = new Map<string, IframeCache>();

  const captureElement = async (element: any) => {
    const embedIframeVersionNonce = getIframeVersionNonce(element);
    const previousCache = iframeCacheMap.get(element.id);
    const canReusePreviousCache = Boolean(
      previousCache?.dataURL &&
      previousCache.width === element.width &&
      previousCache.height === element.height,
    );
    let cache = previousCache;
    if (hasCurrentIframeCache(element, cache)) {
      newIframeCacheMap.set(element.id, cache);
      return;
    }
    cache = {
      dataURL: null,
      embedIframeVersionNonce,
      width: element.width,
      height: element.height,
    } as IframeCache;
    newIframeCacheMap.set(element.id, cache);

    const iframe = getIframeForElement(element);
    if (!iframe) {
      if (canReusePreviousCache) {
        newIframeCacheMap.set(element.id, previousCache);
      }
      return;
    }

    if (!(await waitForIframeLoad(iframe))) {
      if (canReusePreviousCache) {
        newIframeCacheMap.set(element.id, previousCache);
      }
      return;
    }

    // The frame may have finished loading after the pre-save flush pass.
    // Flush once more at the capture boundary so its debounce queue cannot
    // leave the raster behind the scene data.
    await flushIframePendingInput(iframe);
    const dataURL = await captureIframe(iframe);
    if (dataURL) {
      cache.dataURL = dataURL;
      newIframeCacheMap.set(element.id, cache);
    } else if (canReusePreviousCache) {
      // Keep a known-good frame when a transient iframe load/capture fails.
      // The old nonce makes the next save retry the capture.
      newIframeCacheMap.set(element.id, previousCache);
    }
  };

  await processArraySequentially(elementsToCapture, captureElement);

  return newIframeCacheMap;
}

/**
 * 创建 Excalidraw 文件对象
 */
export function createImageFile(
  elementId: string,
  svgDataURL: string
): { fileId: string; file: any } {
  const fileId = `file-${elementId}-${Date.now()}`;

  return {
    fileId,
    file: {
      id: fileId,
      dataURL: svgDataURL,
      mimeType: 'image/svg+xml',
      created: Date.now(),
    },
  };
}

/**
 * 替换元素中的 iframe 为图像
 * 每个 embeddable 元素会被替换成：矩形背景 + SVG 图像
 */
export function replaceIframesWithImages(
  elements: any[],
  iframeCacheMap: Map<string, IframeCache>,
  files: any
): { elements: any[]; files: any } {
  const newFiles: any = {};

  // 使用 flatMap 将每个元素映射为 1 个或 2 个元素
  const processedElements = elements.flatMap((element) => {
    const cache = iframeCacheMap.get(element.id);
    if (!(cache?.dataURL)) {
      return [element]; // 没有捕获到 iframe，保持原样
    }

    const { fileId, file } = createImageFile(element.id, cache.dataURL);
    newFiles[fileId] = file;

    // 返回两个元素：矩形背景 + SVG 图像
    return [
      {
        // 矩形背景元素
        id: `${element.id}-rect`,
        type: 'rectangle',
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        angle: element.angle,
        strokeColor: element.strokeColor,
        backgroundColor: element.backgroundColor,
        fillStyle: element.fillStyle,
        strokeWidth: element.strokeWidth,
        strokeStyle: element.strokeStyle,
        roundness: element.roundness,
        opacity: element.opacity,
        groupIds: element.groupIds,
        frameId: element.frameId,
      },
      {
        // SVG 图像元素
        id: `${element.id}-image`,
        type: 'image',
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        angle: element.angle,
        fileId: fileId,
        opacity: element.opacity,
        groupIds: element.groupIds,
        frameId: element.frameId,
        roundness: element.roundness,
      },
    ];
  });

  return { elements: processedElements, files: { ...files, ...newFiles } };
}

export function computeHash(str: string): string {
  const hashHex = CryptoJS.SHA256(str).toString();
  return hashHex;
}

const CACHE_VERSION = 1;
const iframeCacheWriteQueues = new Map<string, Promise<void>>();

const writeIframeCacheMap = async (
  imageURL: string,
  iframeCacheMap: Map<string, IframeCache>,
) => {
  const imageHash = computeHash(imageURL);
  const cacheData = {
    cacheVersion: CACHE_VERSION,
    imageURL: imageURL,
    iframeCacheData: Object.fromEntries(iframeCacheMap),
  }
  const iframeCacheData = JSON.stringify(cacheData);
  const file = new File([iframeCacheData], `cache-${imageHash}.json`, { type: 'application/json' });
  const formData = new FormData();
  formData.append('path', `/temp/siyuan-embed-excalidraw-plus/cache/cache-${imageHash}.json`);
  formData.append('file', file);
  formData.append('isDir', 'false');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/file/putFile', {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const responseText = await response.text();
    let result: any = null;
    if (responseText) {
      try {
        result = JSON.parse(responseText);
      } catch (error) {
        // Older SiYuan versions can return an empty or plain-text success body.
      }
    }
    if (!response.ok) throw new Error(`iframe cache HTTP ${response.status}`);
    if (result && typeof result.code === 'number' && result.code !== 0) {
      throw new Error(`iframe cache API ${result.code}: ${result.msg || 'unknown error'}`);
    }
  } finally {
    window.clearTimeout(timeout);
  }
}

export function putIframeCacheMap(
  imageURL: string,
  iframeCacheMap: Map<string, IframeCache>,
): Promise<void> {
  const imageHash = computeHash(imageURL);
  const snapshot = new Map<string, IframeCache>(
    Array.from(
      iframeCacheMap.entries(),
      ([id, cache]) => [id, { ...cache }] as const,
    ),
  );
  const previousWrite = iframeCacheWriteQueues.get(imageHash) ?? Promise.resolve();
  const currentWrite = previousWrite
    .catch(() => undefined)
    .then(() => writeIframeCacheMap(imageURL, snapshot));
  iframeCacheWriteQueues.set(imageHash, currentWrite);
  currentWrite.then(
    () => {
      if (iframeCacheWriteQueues.get(imageHash) === currentWrite) {
        iframeCacheWriteQueues.delete(imageHash);
      }
    },
    () => {
      if (iframeCacheWriteQueues.get(imageHash) === currentWrite) {
        iframeCacheWriteQueues.delete(imageHash);
      }
    },
  );
  return currentWrite;
}

export async function getIframeCacheMap(imageURL: string): Promise<Map<string, IframeCache>> {
  const imageHash = computeHash(imageURL);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/file/getFile', {
      method: 'POST',
      body: JSON.stringify({
        path: `/temp/siyuan-embed-excalidraw-plus/cache/cache-${imageHash}.json`,
      }),
      signal: controller.signal,
    });
    if (response.ok && response.status === 200) {
      const iframeCacheData = await response.json();
      if (
        iframeCacheData.cacheVersion === CACHE_VERSION &&
        iframeCacheData.imageURL === imageURL &&
        iframeCacheData.iframeCacheData &&
        typeof iframeCacheData.iframeCacheData === 'object'
      ) {
        return new Map<string, IframeCache>(
          Object.entries(iframeCacheData.iframeCacheData).filter(
            ([id, cache]) => typeof id === 'string' && isStoredIframeCache(cache),
          ) as [string, IframeCache][],
        );
      }
    }
  } catch (error) {
    console.warn('Failed to load iframe cache', error);
  } finally {
    window.clearTimeout(timeout);
  }
  return new Map<string, IframeCache>();
}
