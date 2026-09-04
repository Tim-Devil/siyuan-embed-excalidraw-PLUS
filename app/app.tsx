import { debounce } from 'lodash';
import { createRoot } from 'react-dom/client';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Excalidraw,
  loadFromBlob,
  exportToSvg,
  exportToBlob,
  parseLibraryTokensFromUrl,
  loadLibraryFromBlob,
  mergeLibraryItems,
  serializeLibraryAsJSON,
  MainMenu,
  viewportCoordsToSceneCoords,
  FONT_FAMILY,
  MIN_FONT_SIZE,
  Fonts,
  LOCAL_FONT_CUSTOM_DATA_KEY,
} from '@excalidraw/excalidraw';
import type { LocalFontDescriptor } from '@excalidraw/excalidraw';
import { ClipboardData } from '@excalidraw/excalidraw/clipboard';
import '@excalidraw/excalidraw/index.css';
import './app.scss';
import {
  addStyle,
  HTMLToElement,
  blobToArray,
  blobToDataURL,
  base64ToUnicode,
  upsertPNGtEXt,
  base64ToArray,
  getSVGSize,
  getPNGSize,
} from '../src/utils';
import { isMac, matchHotKey, updateHotkeyTip } from '../src/utils/hotkey';
import defaultImageContent from "../src/default.json";
import { nanoid } from "nanoid";
import {
  captureAllIframes,
  flushAllIframeEdits,
  getIframeCacheMap,
  getIframeVersionNonce,
  hasCompleteIframeCache,
  needsIframeCapture,
  putIframeCacheMap,
  replaceIframesWithImages,
} from './utils/iframeCapture';

addStyle("/stage/protyle/js/katex/katex.min.css", "protyleKatexStyle");

window.EXCALIDRAW_ASSET_PATH = '/plugins/siyuan-embed-excalidraw-plus/app/';
window.EXCALIDRAW_LIBRARY_PATH = '/data/storage/petal/siyuan-embed-excalidraw-plus/library.excalidrawlib';
window.EXCALIDRAW_LOCAL_FONT_STORAGE_KEY = 'siyuan-embed-excalidraw-plus:local-fonts:v1';
const urlParams = new URLSearchParams(window.location.search);
const langCode = urlParams.get('lang') || 'en';
const enableAutoSave = urlParams.get('enableAutoSave') === 'true';
const rememberTextStyle = urlParams.get('rememberTextStyle') === 'true';
const getDelayMs = (value: string | null, fallbackSeconds: number) => {
  const trimmedValue = value?.trim() ?? '';
  const parsedSeconds = trimmedValue === '' ? Number.NaN : Number(trimmedValue);
  const seconds = Number.isFinite(parsedSeconds) ? parsedSeconds : fallbackSeconds;
  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds)) {
    return seconds > 0 ? 2_147_483_647 : 300;
  }
  return Math.min(Math.max(milliseconds, 300), 2_147_483_647);
};
const autoSaveInterval = getDelayMs(urlParams.get('autoSaveInterval'), 0);
const fullSaveDelay = getDelayMs(urlParams.get('fullSaveDelay'), 0);
const TEXT_STYLE_STORAGE_KEY = 'siyuan-embed-excalidraw-plus:text-style:v1';
const EXCALIDRAW_PNG_METADATA_KEY = 'application/vnd.excalidraw+json';
const BUILT_IN_FONT_FAMILIES = new Set<number>(Object.values(FONT_FAMILY));

const mergePNGMetadata = (
  metadataSource: Uint8Array,
  imageData: Uint8Array,
): Uint8Array => {
  try {
    return upsertPNGtEXt(
      metadataSource,
      imageData,
      EXCALIDRAW_PNG_METADATA_KEY,
    );
  } catch (error) {
    // Preserve the freshly rendered image when a non-Excalidraw PNG lacks
    // the metadata chunk required for editability.
    console.warn('PNG scene metadata is unavailable; keeping rendered image', error);
    return imageData;
  }
};

const fetchBlobWithTimeout = async (
  input: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ response: Response; blob: Blob }> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    const blob = await response.blob();
    return { response, blob };
  } finally {
    window.clearTimeout(timeout);
  }
};

type SaveEventName = 'save' | 'autosave';

type TextStyleSnapshot = {
  fontFamily: number;
  fontSize: number;
};

type StoredTextStyle = TextStyleSnapshot & {
  version: 1;
  localFontDescriptor?: LocalFontDescriptor;
};

const isLocalFontDescriptor = (value: unknown): value is LocalFontDescriptor => {
  if (!value || typeof value !== 'object') return false;
  const descriptor = value as Partial<LocalFontDescriptor>;
  const metrics = descriptor.metrics;
  return Number.isSafeInteger(descriptor.id)
    && typeof descriptor.family === 'string'
    && descriptor.family.trim().length > 0
    && typeof descriptor.fullName === 'string'
    && descriptor.fullName.trim().length > 0
    && typeof descriptor.postscriptName === 'string'
    && descriptor.postscriptName.trim().length > 0
    && typeof descriptor.style === 'string'
    && descriptor.style.trim().length > 0
    && !!metrics
    && Number.isFinite(metrics.unitsPerEm)
    && metrics.unitsPerEm > 0
    && Number.isFinite(metrics.ascender)
    && Number.isFinite(metrics.descender)
    && Number.isFinite(metrics.lineHeight)
    && metrics.lineHeight > 0;
};

const readRememberedTextStyle = (): Partial<TextStyleSnapshot> | null => {
  if (!rememberTextStyle) return null;

  try {
    const storedValue = localStorage.getItem(TEXT_STYLE_STORAGE_KEY);
    if (!storedValue) return null;

    const stored = JSON.parse(storedValue) as Partial<StoredTextStyle>;
    if (!stored || stored.version !== 1) return null;

    const restored: Partial<TextStyleSnapshot> = {};
    if (typeof stored.fontSize === 'number'
      && Number.isFinite(stored.fontSize)
      && stored.fontSize >= MIN_FONT_SIZE) {
      restored.fontSize = stored.fontSize;
    }

    if (typeof stored.fontFamily === 'number' && Number.isSafeInteger(stored.fontFamily)) {
      if (isLocalFontDescriptor(stored.localFontDescriptor)) {
        restored.fontFamily = Fonts.resolveLocalFontFamily(
          { [LOCAL_FONT_CUSTOM_DATA_KEY]: stored.localFontDescriptor },
          FONT_FAMILY.Excalifont,
        );
      } else if (BUILT_IN_FONT_FAMILIES.has(stored.fontFamily)) {
        restored.fontFamily = stored.fontFamily;
      }
    }

    return Object.keys(restored).length > 0 ? restored : null;
  } catch (error) {
    console.warn('Failed to restore the remembered Excalidraw text style', error);
    return null;
  }
};

const writeRememberedTextStyle = (style: TextStyleSnapshot) => {
  const stored: StoredTextStyle = {
    version: 1,
    ...style,
  };
  const localFontDescriptor = Fonts.getLocalFontDescriptor(style.fontFamily);
  if (localFontDescriptor) stored.localFontDescriptor = localFontDescriptor;

  try {
    localStorage.setItem(TEXT_STYLE_STORAGE_KEY, JSON.stringify(stored));
  } catch (error) {
    console.warn('Failed to remember the Excalidraw text style', error);
  }
};

type SaveRequest = {
  forceFocus: boolean;
  resolve: (success: boolean) => void;
};

let saveStatus = {
  fullSave: true,
};
let sceneGeneration = 0;
let saveSequence = 0;
let saveWorker: Promise<void> | null = null;
const pendingFullSaves: SaveRequest[] = [];
const pendingAutoSaves: SaveRequest[] = [];
let librarySaveQueue: Promise<void> = Promise.resolve();
let mimeType = 'image/svg+xml';
let imageURL = '';
const exportPadding = 10;
let savedSvg: HTMLElement | null = null;
let savedPngBinaryArray: Uint8Array | null = null;
let defaultSvg: HTMLElement | null = null;
let defaultPngBinaryArray: Uint8Array | null = null;
let iframeCacheMap = new Map<string, IframeCache>();

const postMessage = (message: any) => {
  window.parent?.postMessage(JSON.stringify(message), '*');
};

const getEmbeddableLink = (element: any): string => {
  if (element?.type !== 'embeddable') return '';

  const link = element?.link || '';

  // 处理 Markdown 链接 (通过检查 customData.embedMarkdown 是否存在)
  if (element?.customData?.embedMarkdown) {
    return `/plugins/siyuan-embed-excalidraw-plus/embed/markdown/?elementId=${element.id}`;
  }

  // 处理思源块链接
  if (link?.startsWith('siyuan://blocks/')) {
    const blockId = link.split('siyuan://blocks/')[1];
    return `/plugins/siyuan-embed-excalidraw-plus/embed/siyuan/?elementId=${element.id}&blockId=${blockId}`;
  }

  return link;
}

const renderEmbeddable = (element: any, appState: any): React.JSX.Element | null => {
  const src = getEmbeddableLink(element);
  if (!src) return null;

  return (
    <iframe
      className={`excalidraw__embeddable`}
      src={src}
      referrerPolicy="no-referrer-when-downgrade"
      title="Excalidraw Embedded Content"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen={true}
      style={needsIframeCapture(element) ? {filter: 'var(--theme-filter)'} : {}}
      sandbox={`allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads`}
    />
  )
}

const fixSvgContent = (svg: HTMLElement): HTMLElement => {
  // 当图像为空时，使用默认的占位图
  const imageSize = getSVGSize(svg);
  if (imageSize && imageSize.width <= 20 && imageSize.height <= 20) {
    return (defaultSvg?.cloneNode(true) as HTMLElement | null) || svg;
  }
  return svg;
}

const fixPngContent = (pngBinaryArray: Uint8Array): Uint8Array => {
  const imageSize = getPNGSize(pngBinaryArray);
  if (imageSize && imageSize.width <= 20 && imageSize.height <= 20) {
    return defaultPngBinaryArray?.slice() || pngBinaryArray;
  }
  return pngBinaryArray;
}

const triggleToast = (messageType: 'saving' | 'savedone' | 'savetimeout' | 'savecancel') => {
  if (!window.excalidrawAPI) return;
  let message = '';
  let duration = 1000;
  if (messageType == 'savedone') {
    message = langCode.startsWith('zh') ? '保存成功' : 'Saved';
    duration = 2000;
  } else if (messageType == 'savetimeout') {
    message = langCode.startsWith('zh') ? '保存超时' : 'Save timeout';
    duration = 2000;
  } else if (messageType == 'savecancel') {
    message = langCode.startsWith('zh') ? '保存取消' : 'Save canceled';
  } else if (messageType == 'saving') {
    message = langCode.startsWith('zh') ? '保存中...' : 'Saving...';
    duration = Infinity;
  }
  window.excalidrawAPI.setToast(null);
  window.excalidrawAPI.setToast({
    message: message,
    closable: false,
    duration: duration,
  });
}

const renderImageContentWithOnlyMetadata = async (): Promise<Blob> => {
  const elements = window.excalidrawAPI.getSceneElements();
  const files = window.excalidrawAPI.getFiles();
  const appState = window.excalidrawAPI.getAppState();

  let blob: Blob | null = null;

  if (mimeType === 'image/svg+xml') {
    // ===== SVG 分支 =====

    // a. 导出原始 SVG（包含完整 iframe 渲染）
    const originalSvg = await exportToSvg({
      elements: elements,
      appState: {
        ...appState,
        exportWithDarkMode: false,
        exportEmbedScene: true,
        exportBackground: false,
      },
      files: files,
      renderEmbeddables: false,
    });

    // b. 保留有效的占位图像，再写入当前场景 metadata
    savedSvg = fixSvgContent(savedSvg || originalSvg);
    const originalMetadata = originalSvg.querySelector('metadata')?.innerHTML;
    const savedMetadataEl = savedSvg.querySelector('metadata');
    if (savedMetadataEl && originalMetadata) {
      savedMetadataEl.innerHTML = originalMetadata;
    }

    // c. 转换为 dataURL
    blob = new Blob([savedSvg!.outerHTML], { type: 'image/svg+xml' });
  } else {
    // ===== PNG 分支 =====

    // a. 导出原始 PNG（包含完整 iframe 渲染）
    const originalPngBlob = await exportToBlob({
      elements: elements,
      appState: {
        ...appState,
        exportWithDarkMode: false,
        exportEmbedScene: true,
        exportBackground: false,
      },
      files: files,
      mimeType: 'image/png',
      exportPadding: exportPadding,
    });
    const originalBinaryArray = await blobToArray(originalPngBlob);

    // b. 保留有效的占位图像，再写入当前场景 metadata
    const displayPng = fixPngContent(savedPngBinaryArray || originalBinaryArray);
    savedPngBinaryArray = mergePNGMetadata(originalBinaryArray, displayPng);
    blob = new Blob([savedPngBinaryArray as any], { type: "image/png" });
  }

  return blob;
}

const renderImageContentWithMetadataAndImage = async (): Promise<Blob> => {
  const api = window.excalidrawAPI;
  if (!api) throw new Error('Excalidraw API is unavailable');

  const getIframeSceneSignature = (sceneElements: readonly any[]) => sceneElements
    .filter(needsIframeCapture)
    .map((element: any) => [
      element.id,
      element.version,
      element.versionNonce,
      getIframeVersionNonce(element),
      element.width,
      element.height,
    ].join(':'))
    .join('\u0001');

  let elements = api.getSceneElements();
  let files = api.getFiles();
  let appState = api.getAppState();
  let captureStable = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await flushAllIframeEdits(elements);
    elements = api.getSceneElements();
    files = api.getFiles();
    appState = api.getAppState();
    const signatureBeforeCapture = getIframeSceneSignature(elements);
    iframeCacheMap = await captureAllIframes(elements, iframeCacheMap);
    const latestElements = api.getSceneElements();
    if (signatureBeforeCapture === getIframeSceneSignature(latestElements)) {
      elements = latestElements;
      files = api.getFiles();
      appState = api.getAppState();
      captureStable = true;
      break;
    }
    elements = latestElements;
  }

  if (!captureStable || !hasCompleteIframeCache(elements, iframeCacheMap)) {
    throw new Error('Embedded iframe capture did not reach a stable scene');
  }

  // ========== 第一步：捕获所有 iframe，得到替换后的 elements ==========
  const { elements: processedElements, files: processedFiles } = replaceIframesWithImages(elements, iframeCacheMap, files);

  // ========== 第二步：根据 mimeType 选择分支处理 ==========
  let blob: Blob | null = null;

  if (mimeType === 'image/svg+xml') {
    // ===== SVG 分支 =====

    // a. 导出原始 SVG（包含完整 iframe 渲染）
    const originalSvg = await exportToSvg({
      elements: elements,
      appState: {
        ...appState,
        exportWithDarkMode: false,
        exportEmbedScene: true,
        exportBackground: false,
      },
      files: files,
      renderEmbeddables: false,
    });

    // b. 导出处理后 SVG（iframe 已替换为图像）
    let processedSvg = await exportToSvg({
      elements: processedElements,
      appState: {
        ...appState,
        exportWithDarkMode: false,
        exportEmbedScene: true,
        exportBackground: false,
      },
      files: processedFiles,
      renderEmbeddables: false,
    });

    // c. 保留有效的占位图像，再写入当前场景 metadata
    const originalMetadata = originalSvg.querySelector('metadata')?.innerHTML;
    processedSvg = fixSvgContent(processedSvg);
    const processedMetadataEl = processedSvg.querySelector('metadata');
    if (processedMetadataEl && originalMetadata) {
      processedMetadataEl.innerHTML = originalMetadata;
    }

    // 保存最后一次渲染的图像数据
    savedSvg = processedSvg;

    // d. 转换为 blob
    blob = new Blob([processedSvg.outerHTML], { type: 'image/svg+xml' });
  } else {
    // ===== PNG 分支 =====

    // a. 导出原始 PNG（包含完整 iframe 渲染）
    const originalPngBlob = await exportToBlob({
      elements: elements,
      appState: {
        ...appState,
        exportWithDarkMode: false,
        exportEmbedScene: true,
        exportBackground: false,
      },
      files: files,
      mimeType: 'image/png',
      exportPadding: exportPadding,
    });
    const originalBinaryArray = await blobToArray(originalPngBlob);

    // b. 导出处理后 PNG（iframe 已替换为图像）
    const processedPngBlob = await exportToBlob({
      elements: processedElements,
      appState: {
        ...appState,
        exportWithDarkMode: false,
        exportEmbedScene: true,
        exportBackground: false,
      },
      files: processedFiles,
      mimeType: 'image/png',
      exportPadding: exportPadding,
    });
    let processedBinaryArray = await blobToArray(processedPngBlob);

    processedBinaryArray = fixPngContent(processedBinaryArray);
    processedBinaryArray = mergePNGMetadata(
      originalBinaryArray,
      processedBinaryArray,
    );

    // 保存最后一次渲染的图像数据
    savedPngBinaryArray = processedBinaryArray;

    blob = new Blob([processedBinaryArray as any], { type: 'image/png' });
  }

  return blob;
}

const putFile = async (formData: FormData, timeoutMs = 30000): Promise<void> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

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
        // SiYuan versions with an empty or plain-text success response remain valid.
      }
    }

    if (!response.ok) {
      throw new Error(`putFile HTTP ${response.status}`);
    }
    if (result && typeof result.code === 'number' && result.code !== 0) {
      throw new Error(`putFile API ${result.code}: ${result.msg || 'unknown error'}`);
    }
  } finally {
    window.clearTimeout(timeout);
  }
};

const putImageFile = (formData: FormData): Promise<void> => putFile(formData);

const notifySave = (eventName: SaveEventName): void => {
  saveSequence += 1;
  postMessage({
    event: eventName,
    imageURL: imageURL,
    saveId: `${Date.now()}-${saveSequence}`,
  });
};

const persistSave = async (eventName: SaveEventName, forceFocus: boolean): Promise<boolean> => {
  if (!window.excalidrawAPI) return false;
  if (!forceFocus && !document.hasFocus()) {
    if (eventName === 'save') triggleToast('savecancel');
    return false;
  }

  const previousSavedSvg = savedSvg?.cloneNode(true) as HTMLElement | null;
  const previousSavedPngBinaryArray = savedPngBinaryArray?.slice() || null;
  const previousIframeCacheMap = new Map(iframeCacheMap);
  let writeSucceeded = false;
  if (eventName === 'save') triggleToast('saving');

  try {
    const blob = eventName === 'save'
      ? await renderImageContentWithMetadataAndImage()
      : await renderImageContentWithOnlyMetadata();

    if (!forceFocus && !document.hasFocus()) {
      if (eventName === 'save') triggleToast('savecancel');
      return false;
    }

    const file = new File([blob], imageURL.split('/').pop()!, { type: blob.type });
    const formData = new FormData();
    formData.append('path', 'data/' + imageURL);
    formData.append('file', file);
    formData.append('isDir', 'false');
    await putImageFile(formData);
    if (eventName === 'save') {
      // Keep cache writes in the same order as image writes. A detached write
      // can otherwise finish after a newer save and restore stale iframe data.
      try {
        await putIframeCacheMap(imageURL, iframeCacheMap);
      } catch (error) {
        console.warn('Failed to persist iframe cache', error);
      }
    }
    writeSucceeded = true;

    return true;
  } catch (error) {
    console.error(`Excalidraw ${eventName} failed`, error);
    if (eventName === 'save') {
      saveStatus.fullSave = false;
      triggleToast('savetimeout');
    }
    return false;
  } finally {
    if (!writeSucceeded) {
      savedSvg = previousSavedSvg;
      savedPngBinaryArray = previousSavedPngBinaryArray;
      iframeCacheMap = previousIframeCacheMap;
    }
  }
};

const drainSaveQueue = async (): Promise<void> => {
  while (pendingFullSaves.length > 0 || pendingAutoSaves.length > 0) {
    const isFullSave = pendingFullSaves.length > 0;
    const requests = (isFullSave ? pendingFullSaves : pendingAutoSaves).splice(0);
    const generationAtStart = sceneGeneration;
    const forceFocus = requests.some(request => request.forceFocus);
    let success = false;
    try {
      success = await persistSave(isFullSave ? 'save' : 'autosave', forceFocus);
    } catch (error) {
      console.error('Excalidraw save queue failed', error);
      if (isFullSave) saveStatus.fullSave = false;
    }

    if (isFullSave && success && sceneGeneration !== generationAtStart) {
      // Changes made during export or upload require a fresh full raster.
      pendingFullSaves.unshift(...requests);
      continue;
    }

    requests.forEach(request => request.resolve(success));

    if (isFullSave && success && sceneGeneration === generationAtStart) {
      notifySave('save');
      triggleToast('savedone');
      saveStatus.fullSave = true;
      // A full save already contains the metadata requested by queued autosaves.
      const redundantAutoSaves = pendingAutoSaves.splice(0);
      redundantAutoSaves.forEach(request => request.resolve(true));
    } else if (isFullSave && !success) {
      // Metadata-only writes cannot represent a failed full raster save.
      const canceledAutoSaves = pendingAutoSaves.splice(0);
      canceledAutoSaves.forEach(request => request.resolve(false));
    } else if (!isFullSave && success) {
      notifySave('autosave');
    }
  }
};

const startSaveWorker = (): void => {
  if (saveWorker) return;
  saveWorker = drainSaveQueue().finally(() => {
    saveWorker = null;
    if (pendingFullSaves.length > 0 || pendingAutoSaves.length > 0) {
      startSaveWorker();
    }
  });
};

const save = (eventName: SaveEventName, options: { forceFocus?: boolean } = {}): Promise<boolean> => {
  const forceFocus = options.forceFocus === true;
  if (!window.excalidrawAPI) return Promise.resolve(false);
  if (!forceFocus && !document.hasFocus()) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const request = { forceFocus, resolve };
    if (eventName === 'save') {
      pendingFullSaves.push(request);
    } else {
      pendingAutoSaves.push(request);
    }

    startSaveWorker();
  });
};

const saveAndExit = async (): Promise<void> => {
  const success = await save('save', { forceFocus: true });
  if (success) postMessage({ event: 'exit' });
};

const openLink = (element: any, event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement>; }>) => {
  event.preventDefault();

  if (!element.link) return;
  const api = window.excalidrawAPI;
  if (!api) return;

  const match = element.link.match(/^(element|group)=([^&?#\s]+)$/i);
  if (match) {
    const linktype = match[1].toLowerCase() as 'element' | 'group';
    const value = match[2];

    const sceneElements = api.getSceneElements();
    const targets = sceneElements.filter((element: any) => {
      if (linktype === 'element') {
        return element.id === value;
      } else {
        return element.groupIds?.includes(value);
      }
    });
    if (targets.length > 0) {
      api.scrollToContent(targets, {
        animate: true,
      });
    }
  }
  else {
    window.open(element.link, '_blank');
  }
}

const App = (props: { initialData: any }) => {
  const lastAutoSaveTimeRef = useRef(0);
  const changeInitStatusRef = useRef(true);
  const lastSceneSignatureRef = useRef("");
  const lastTextStyleRef = useRef<TextStyleSnapshot | null>(null);
  const pendingTextStyleWriteRef = useRef(false);
  const libraryChangeInitStatusRef = useRef(true);
  const apiRef = useRef<any>(null);

  // Keep debounced callbacks stable for the lifetime of this iframe. Recreating
  // them on every Excalidraw render loses pending timers and resets the cadence.
  const debouncedAutoSave = useMemo(
    () =>
      debounce(() => {
        const currentTime = Date.now();
        if (
          currentTime - lastAutoSaveTimeRef.current > autoSaveInterval &&
          window.excalidrawAPI
        ) {
          lastAutoSaveTimeRef.current = currentTime;
          void save("autosave");
        }
      }, 300),
    [],
  );
  const debouncedSave = useMemo(
    () =>
      debounce(() => {
        if (
          !saveStatus.fullSave &&
          window.excalidrawAPI &&
          !window.excalidrawAPI.getAppState().activeEmbeddable
        ) {
          void save("save");
        }
      }, fullSaveDelay),
    [],
  );

  useEffect(() => {
    return () => {
      debouncedAutoSave.cancel();
      debouncedSave.cancel();
      if (window.excalidrawAPI === apiRef.current) {
        window.excalidrawAPI = undefined;
      }
      apiRef.current = null;
    };
  }, [debouncedAutoSave, debouncedSave]);

  const trackTextStyle = useCallback((state: any) => {
    if (!rememberTextStyle) return;

    const currentStyle = {
      fontFamily: state.currentItemFontFamily,
      fontSize: state.currentItemFontSize,
    };
    if (!Number.isSafeInteger(currentStyle.fontFamily)
      || !Number.isFinite(currentStyle.fontSize)
      || currentStyle.fontSize < MIN_FONT_SIZE) return;

    if (lastTextStyleRef.current === null) {
      lastTextStyleRef.current = currentStyle;
      return;
    }

    const styleChanged =
      lastTextStyleRef.current.fontFamily !== currentStyle.fontFamily ||
      lastTextStyleRef.current.fontSize !== currentStyle.fontSize;
    lastTextStyleRef.current = currentStyle;
    if (!styleChanged) return;

    const hasSelection = Object.values(state.selectedElementIds || {}).some(Boolean);
    if (hasSelection) {
      if (styleChanged) pendingTextStyleWriteRef.current = true;
      return;
    }

    if (styleChanged || pendingTextStyleWriteRef.current) {
      writeRememberedTextStyle(currentStyle);
      pendingTextStyleWriteRef.current = false;
    }
  }, []);

  const handleChange = useCallback((elements: readonly any[], state: any) => {
    trackTextStyle(state);
    const sceneSignature = elements
      .map((element: any) => `${element.id}:${element.version}:${element.versionNonce}`)
      .join("\u0001");

    if (changeInitStatusRef.current) {
      // 忽略初始化导致的第一次变化
      lastSceneSignatureRef.current = sceneSignature;
      changeInitStatusRef.current = false;
      return;
    }

    if (sceneSignature !== lastSceneSignatureRef.current) {
      lastSceneSignatureRef.current = sceneSignature;
      sceneGeneration += 1;
      saveStatus.fullSave = false;

      // 只有启用自动保存时才执行防抖保存
      if (enableAutoSave) {
        debouncedAutoSave();
        debouncedSave();
      }
    }
  }, [debouncedAutoSave, debouncedSave, trackTextStyle]);

  const handlePaste = (data: ClipboardData, event: ClipboardEvent | null): boolean => {
    return true;
  }

  const handleLibraryChange = useCallback(async (libraryItems: any) => {
    if (libraryChangeInitStatusRef.current) {
      // 忽略初始化导致的第一次变化
      libraryChangeInitStatusRef.current = false;
      return;
    }
    try {
      await saveLibrary(libraryItems);
    } catch (error) {
      console.warn('Failed to save Excalidraw library', error);
    }
  }, []);

  const setExcalidrawAPI = useCallback((api: any) => {
    apiRef.current = api;
    window.excalidrawAPI = api;

    // 通知已准备好
    postMessage({ event: 'ready' });
  }, []);

  return (
    <Excalidraw
      initialData={props.initialData}
      langCode={langCode}
      onChange={handleChange}
      onPaste={handlePaste}
      onLibraryChange={handleLibraryChange}
      excalidrawAPI={setExcalidrawAPI}
      validateEmbeddable={true}
      renderEmbeddable={renderEmbeddable}
      generateLinkForSelection={(id: string, type: "element" | "group") => { return `${type}=${id}`; }}
      onLinkOpen={openLink}
      UIOptions={{
        canvasActions: {
          loadScene: true,
          saveToActiveFile: false,
        },
      }}
    >
      <MainMenu>
        <MainMenu.Item
          icon={<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5651" width="32" height="32"><path d="M921.6 450.133333c-6.4-8.533333-14.933333-12.8-25.6-12.8h-10.666667V341.333333c0-40.533333-34.133333-74.666667-74.666666-74.666666H514.133333c-4.266667 0-6.4-2.133333-8.533333-4.266667l-38.4-66.133333c-12.8-21.333333-38.4-36.266667-64-36.266667H170.666667c-40.533333 0-74.666667 34.133333-74.666667 74.666667v597.333333c0 6.4 2.133333 12.8 6.4 19.2 6.4 8.533333 14.933333 12.8 25.6 12.8h640c12.8 0 25.6-8.533333 29.866667-21.333333l128-362.666667c4.266667-10.666667 2.133333-21.333333-4.266667-29.866667zM170.666667 224h232.533333c4.266667 0 6.4 2.133333 8.533333 4.266667l38.4 66.133333c12.8 21.333333 38.4 36.266667 64 36.266667H810.666667c6.4 0 10.666667 4.266667 10.666666 10.666666v96H256c-12.8 0-25.6 8.533333-29.866667 21.333334l-66.133333 185.6V234.666667c0-6.4 4.266667-10.666667 10.666667-10.666667z m573.866666 576H172.8l104.533333-298.666667h571.733334l-104.533334 298.666667z" fill="#666666" p-id="5652"></path></svg>}
          onSelect={() => { document.querySelector("#root .excalidraw")?.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'keyO', ctrlKey: !isMac(), metaKey: isMac(), bubbles: true, cancelable: true })) }}
        >{langCode.startsWith('zh') ? '打开' : 'Open'}
        </MainMenu.Item>
        <MainMenu.Item
          icon={<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="7082" width="32" height="32"><path d="M928 896V314.24c0-8.32-3.488-16.64-9.6-22.72l-187.84-186.24a31.36 31.36 0 0 0-22.4-9.28H672v160c0 52.8-43.2 96-96 96H256c-52.8 0-96-43.2-96-96V96H128c-17.6 0-32 14.4-32 32v768c0 17.6 14.4 32 32 32h64v-288c0-52.8 43.2-96 96-96h448c52.8 0 96 43.2 96 96v288h64c17.632 0 32-14.4 32-32z m-160 32v-288c0-17.6-14.368-32-32-32H288c-17.6 0-32 14.4-32 32v288h512zM224 96v160c0 17.6 14.4 32 32 32h320c17.632 0 32-14.4 32-32V96H224z m739.52 150.08c18.272 17.92 28.48 42.88 28.48 68.16V896c0 52.8-43.2 96-96 96H128c-52.8 0-96-43.2-96-96V128c0-52.8 43.2-96 96-96h580.16c25.632 0 49.632 9.92 67.52 27.84l187.84 186.24zM512 256a32 32 0 0 1-32-32V160a32 32 0 0 1 64 0v64a32 32 0 0 1-32 32z" fill="#404853" p-id="7083"></path></svg>}
          onSelect={() => { void save("save"); }}
          shortcut={updateHotkeyTip('⌘S')}
        >{langCode.startsWith('zh') ? '保存' : 'Save'}
        </MainMenu.Item>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.Item
          icon={<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5086" width="32" height="32"><path d="M768 640 768 512 448 512 448 384 768 384 768 256 960 448ZM704 576 704 832 384 832 384 1024 0 832 0 0 704 0 704 320 640 320 640 64 128 64 384 192 384 768 640 768 640 576Z" fill="#000000" p-id="5087"></path></svg>}
          onSelect={() => { void saveAndExit(); }}
        >{langCode.startsWith('zh') ? '退出' : 'Exit'}
        </MainMenu.Item>
        {
          urlParams.get('fullscreenBtn') == '1' &&
          <MainMenu.Item
            icon={<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="6075" width="32" height="32"><path d="M692.705882 24.094118h240.941177c36.141176 0 60.235294 24.094118 60.235294 60.235294s-24.094118 60.235294-60.235294 60.235294h-240.941177c-36.141176 0-60.235294-24.094118-60.235294-60.235294s24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6076"></path><path d="M933.647059 24.094118c36.141176 0 60.235294 24.094118 60.235294 60.235294v240.941176c0 36.141176-24.094118 60.235294-60.235294 60.235294s-60.235294-24.094118-60.235294-60.235294v-240.941176c0-36.141176 24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6077"></path><path d="M915.576471 96.376471c18.070588 24.094118 18.070588 60.235294 0 84.329411l-246.964706 246.964706c-24.094118 24.094118-60.235294 24.094118-84.329412 0-24.094118-24.094118-24.094118-60.235294 0-84.329412l246.964706-246.964705c24.094118-18.070588 60.235294-18.070588 84.329412 0zM90.352941 867.388235h240.941177c36.141176 0 60.235294 24.094118 60.235294 60.235294s-24.094118 60.235294-60.235294 60.235295H90.352941c-36.141176 0-60.235294-24.094118-60.235294-60.235295s24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6078"></path><path d="M90.352941 626.447059c36.141176 0 60.235294 24.094118 60.235294 60.235294v240.941176c0 36.141176-24.094118 60.235294-60.235294 60.235295s-60.235294-24.094118-60.235294-60.235295v-240.941176c0-36.141176 24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6079"></path><path d="M102.4 909.552941c-24.094118-24.094118-24.094118-60.235294 0-84.329412l246.964706-246.964705c24.094118-24.094118 60.235294-24.094118 84.329412 0 24.094118 24.094118 24.094118 60.235294 0 84.329411l-246.964706 246.964706c-24.094118 18.070588-60.235294 18.070588-84.329412 0zM90.352941 24.094118h240.941177c36.141176 0 60.235294 24.094118 60.235294 60.235294s-24.094118 60.235294-60.235294 60.235294H90.352941c-36.141176 0-60.235294-24.094118-60.235294-60.235294s24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6080"></path><path d="M90.352941 24.094118c36.141176 0 60.235294 24.094118 60.235294 60.235294v240.941176c0 36.141176-24.094118 60.235294-60.235294 60.235294s-60.235294-24.094118-60.235294-60.235294v-240.941176c0-36.141176 24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6081"></path><path d="M102.4 96.376471c-18.070588 24.094118-18.070588 60.235294 0 84.329411l246.964706 246.964706c24.094118 24.094118 60.235294 24.094118 84.329412 0 24.094118-24.094118 24.094118-60.235294 0-84.329412L186.729412 96.376471c-24.094118-18.070588-60.235294-18.070588-84.329412 0zM692.705882 867.388235h240.941177c36.141176 0 60.235294 24.094118 60.235294 60.235294s-24.094118 60.235294-60.235294 60.235295h-240.941177c-36.141176 0-60.235294-24.094118-60.235294-60.235295s24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6082"></path><path d="M933.647059 626.447059c36.141176 0 60.235294 24.094118 60.235294 60.235294v240.941176c0 36.141176-24.094118 60.235294-60.235294 60.235295s-60.235294-24.094118-60.235294-60.235295v-240.941176c0-36.141176 24.094118-60.235294 60.235294-60.235294z" fill="#1E2330" p-id="6083"></path><path d="M915.576471 909.552941c24.094118-24.094118 24.094118-60.235294 0-84.329412l-246.964706-246.964705c-24.094118-24.094118-60.235294-24.094118-84.329412 0-24.094118 24.094118-24.094118 60.235294 0 84.329411l246.964706 246.964706c24.094118 18.070588 60.235294 18.070588 84.329412 0z" fill="#1E2330" p-id="6084"></path></svg>}
            onSelect={() => { postMessage({ event: 'toggleFullscreen' }); }}
            shortcut={updateHotkeyTip('⌥Y')}
          >{langCode.startsWith('zh') ? '切换全屏' : 'Toggle Fullscreen'}
          </MainMenu.Item>
        }
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.DefaultItems.ClearCanvas />
      </MainMenu>
    </Excalidraw>
  );
};

const load = async () => {
  try {
    imageURL = urlParams.get('imageURL') || '';
    if (!imageURL) return;

    const { response, blob } = await fetchBlobWithTimeout(`/${imageURL}`, { cache: 'reload' });
    if (!response.ok) return;
    const responseMimeType = blob.type.split(';', 1)[0].trim().toLowerCase();
    mimeType = responseMimeType === 'image/png' || responseMimeType === 'image/svg+xml'
      ? responseMimeType
      : imageURL.toLowerCase().split(/[?#]/, 1)[0].endsWith('.png')
        ? 'image/png'
        : 'image/svg+xml';

    if (mimeType === 'image/svg+xml') {
      const dataURL = await blobToDataURL(blob);
      savedSvg = HTMLToElement(base64ToUnicode(dataURL.split(',')[1]));
      defaultSvg = HTMLToElement(base64ToUnicode(defaultImageContent['svg'].split(',')[1]));
    } else {
      savedPngBinaryArray = await blobToArray(blob);
      defaultPngBinaryArray = base64ToArray(defaultImageContent['png'].split(',')[1]);
    }

    iframeCacheMap = await getIframeCacheMap(imageURL);

    const contents = await loadFromBlob(blob, null, null);
    const rememberedTextStyle = readRememberedTextStyle();
    contents.appState = {
      ...contents.appState,
      ...(rememberedTextStyle?.fontFamily !== undefined
        ? { currentItemFontFamily: rememberedTextStyle.fontFamily }
        : {}),
      ...(rememberedTextStyle?.fontSize !== undefined
        ? { currentItemFontSize: rememberedTextStyle.fontSize }
        : {}),
      theme: urlParams.get('dark') == '1' ? 'dark' : 'light',
    };
    createRoot(document.getElementById('root')!).render(React.createElement(App, {
      initialData: {
        elements: contents.elements,
        appState: contents.appState,
        files: contents.files,
        scrollToContent: true,
        libraryItems: await loadLibary(),
      },
    }));
  } catch (error) {
    console.error('Failed to load Excalidraw document', error);
  }
};

const messageHandler = (event: MessageEvent) => {
  if (event.source !== window.parent || typeof event.data !== 'string' || event.data.length === 0) return;
  try {
    const message = JSON.parse(event.data);
    if (message?.event === 'saveAndExit') {
      void save('save', { forceFocus: true }).then((success) => {
        postMessage({
          event: success ? 'exit' : 'saveFailed',
          requestId: message.requestId,
        });
      });
    }
  }
  catch (err) {
    console.error(err);
  }
}

const loadLibary = async () => {
  let libraryItems: any = [];
  try {
    const { response, blob } = await fetchBlobWithTimeout('/api/file/getFile', {
      method: 'POST',
      body: JSON.stringify({
        path: window.EXCALIDRAW_LIBRARY_PATH,
      }),
    }, 5000);
    if (!response.ok) return libraryItems;
    libraryItems = await loadLibraryFromBlob(blob);
  } catch (error) {
    console.warn('Failed to load Excalidraw library', error);
  }
  return libraryItems;
}

const saveLibrary = async (libraryItems: any) => {
  const newLibraryData = serializeLibraryAsJSON(libraryItems);
  const file = new File([newLibraryData], 'library.excalidraw', { type: 'application/json' });
  const formData = new FormData();
  formData.append('path', window.EXCALIDRAW_LIBRARY_PATH);
  formData.append('file', file);
  formData.append('isDir', 'false');
  const currentSave = librarySaveQueue
    .catch(() => undefined)
    .then(() => putFile(formData, 10000));
  librarySaveQueue = currentSave.catch(() => undefined);
  await currentSave;
}

const addLibrary = async (libraryUrlTokens: { libraryUrl: string, idToken: string | null }) => {
  let ok = true;
  try {
    const libraryUrl = decodeURIComponent(libraryUrlTokens.libraryUrl);
    const { response: request, blob } = await fetchBlobWithTimeout(libraryUrl, {}, 15000);
    if (!request.ok) throw new Error(`library HTTP ${request.status}`);
    const addedLibraryItems = await loadLibraryFromBlob(blob, "published");
    const localLibraryItems = await loadLibary();
    const mergedLibraryItems = mergeLibraryItems(localLibraryItems, addedLibraryItems);
    await saveLibrary(mergedLibraryItems);
    console.log('add library success');
  } catch (error) {
    ok = false;
    console.error(error);
    console.log('add library fail');
  }
  document.getElementById('root')!.innerHTML = `<div style="display:flex;justify-content:center;align-items:center;height:100vh;">${ok ? 'Add Library Success' : 'Add Library Fail'}</div>`;
}

const getMarkdownToolButton = () => {
  const html = `
<button data-testid="toolbar-markdown" class="dropdown-menu-item dropdown-menu-item-base">
  <div class="dropdown-menu-item__icon">
    <svg aria-hidden="true" focusable="false" role="img" t="1772027273314" class="" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="7889" width="20" height="20"><path d="M92 192C42.24 192 0 232.128 0 282.016v459.968C0 791.904 42.24 832 92 832h840C981.76 832 1024 791.872 1024 741.984V282.016C1024 232.16 981.76 192 932 192z m0 64h840c16.512 0 28 12.256 28 26.016v459.968c0 13.76-11.52 26.016-28 26.016H92C75.488 768 64 755.744 64 741.984V282.016c0-13.76 11.52-25.984 28-25.984zM160 352v320h96v-212.992l96 127.008 96-127.04V672h96V352h-96l-96 128-96-128z m544 0v160h-96l144 160 144-160h-96v-160z" p-id="7890"></path></svg>
  </div>
  <div class="dropdown-menu-item__text"> Markdown </div>
</button>`.trim();
  const element = HTMLToElement(html);
  element.addEventListener('click', () => {
    const api = window.excalidrawAPI;
    if (!api) return;
    const elementId = nanoid();
    const appState = api.getAppState();
    const { x, y } = viewportCoordsToSceneCoords(
      { clientX: appState.width / 2, clientY: appState.height / 2 },
      appState,
    );

    // 创建 Markdown embeddable 元素
    const newElement = {
      id: elementId,
      type: 'embeddable',
      x,
      y,
      width: 300,
      height: 185,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: 'aO',
      roundness: {
        type: 3,
      },
      seed: Math.floor(Math.random() * 10000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 10000),
      isDeleted: false,
      boundElements: [],
      updated: Date.now(),
      link: `markdown`,
      locked: false,
      customData: {
        embedMarkdown: {
          content: '',
          config: {
          },
        },
        embedIframeVersionNonce: Math.floor(Math.random() * 10000),
      },
    };

    const sceneElements = api.getSceneElements();
    api.updateScene({ elements: [...sceneElements, newElement] });
  });

  return element;
}

window.triggleHoverBlock = (blockId: string, location: { x: number, y: number }) => {
  const frameRect = window.frameElement?.getBoundingClientRect();
  if (!frameRect) return;
  postMessage({
    event: 'triggleHoverBlock',
    blockID: blockId,
    x: frameRect.left + location.x,
    y: frameRect.top + location.y,
  });
}

const setupMutationObserver = () => {
  const bindLibraryButton = (element: Element) => {
    if (element.hasAttribute('data-excalidraw-plus-bound')) return;
    element.setAttribute('data-excalidraw-plus-bound', 'true');
    element.addEventListener('click', () => {
      postMessage({ event: 'browseLibrary' });
    });
  };

  const extendEmbeddableTool = (element: Element) => {
    if (element.hasAttribute('data-excalidraw-plus-extended')) return;
    element.setAttribute('data-excalidraw-plus-extended', 'true');
    const embeddableToolText = element.querySelector('.dropdown-menu-item__text');
    if (embeddableToolText) {
      embeddableToolText.textContent = embeddableToolText.textContent + (langCode.startsWith('zh') ? '/思源超链接' : '/SiYuan Hyperlink');
    }
    element.insertAdjacentElement('afterend', getMarkdownToolButton());
  };

  const processAddedElement = (addedElement: Element) => {
    const libraryButtons = [
      ...(addedElement.matches('.library-menu-browse-button') ? [addedElement] : []),
      ...Array.from(addedElement.querySelectorAll('.library-menu-browse-button')),
    ];
    libraryButtons.forEach(bindLibraryButton);

    const embeddableTools = [
      ...(addedElement.matches(".dropdown-menu-item[data-testid='toolbar-embeddable']") ? [addedElement] : []),
      ...Array.from(addedElement.querySelectorAll(".dropdown-menu-item[data-testid='toolbar-embeddable']")),
    ];
    embeddableTools.forEach(extendEmbeddableTool);
  };

  const mutationObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            processAddedElement(node as Element);
          }
        });
      }
      else if (mutation.type === 'attributes') {
        if (mutation.attributeName === 'class'
          && mutation.target.nodeType === Node.ELEMENT_NODE
          && (mutation.target as HTMLElement).classList.contains('excalidraw-tooltip--visible')
          && window.frameElement
          && mutation.target.textContent?.startsWith('siyuan://blocks/')
        ) {
          const tooltip = mutation.target as HTMLElement;
          const rect = tooltip.getBoundingClientRect();
          const blockId = tooltip.textContent.split('siyuan://blocks/').pop();
          if (blockId) {
            window.triggleHoverBlock(blockId, {x: rect.left, y: rect.top});
          }
        }
      }
    }
  });

  mutationObserver.observe(document, {
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
    subtree: true
  });
  processAddedElement(document.body);
}

const libraryUrlTokens = parseLibraryTokensFromUrl();
if (libraryUrlTokens) {
  addLibrary(libraryUrlTokens);
} else {
  window.addEventListener('message', messageHandler);
  load();
  postMessage({ event: 'init' });
  setupMutationObserver();
}

window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (matchHotKey('⌘S', event)) {
    event.preventDefault();
    if (window.excalidrawAPI && !window.excalidrawAPI.getAppState().activeEmbeddable) {
      void save("save");
    }
  } else if (matchHotKey('⌥Y', event)) {
    event.preventDefault();
    postMessage({ event: 'toggleFullscreen' });
  }
});

window.addEventListener('drop', (event: DragEvent) => {
  if (!window.excalidrawAPI) return;
  const dragElement: HTMLElement | null = window.parent?.siyuan?.dragElement;
  if (dragElement) {
    let blockId = (dragElement.querySelector('.protyle-wysiwyg--select[data-node-id]') as HTMLElement)?.getAttribute('data-node-id');
    if (!blockId && dragElement.nodeName === 'DIV' && dragElement.childNodes.length === 1 && dragElement.firstChild?.nodeName === '#text') {
      blockId = dragElement.textContent;
    }
    if (blockId) {
      const elementId = nanoid();
      const appState = window.excalidrawAPI.getAppState();
      const { x, y } = viewportCoordsToSceneCoords(
        { clientX: event.clientX, clientY: event.clientY },
        appState,
      );

      // 创建 Markdown embeddable 元素
      const newElement = {
        id: elementId,
        type: 'embeddable',
        x,
        y,
        width: 300,
        height: 185,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: 'aO',
        roundness: {
          type: 3,
        },
        seed: Math.floor(Math.random() * 10000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 10000),
        isDeleted: false,
        boundElements: [],
        updated: Date.now(),
        link: `siyuan://blocks/${blockId}`,
        locked: false,
      };

      const sceneElements = window.excalidrawAPI.getSceneElements();
      window.excalidrawAPI.updateScene({ elements: [...sceneElements, newElement] });
    }
  }
});
