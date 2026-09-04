import { SiyuanBlockData } from "./types";

/**
 * 获取父页面的 window 对象
 */
export function getParentWindow(): Window | null {
  return window.parent !== window ? window.parent : null;
}

/**
 * 获取父页面的 excalidraw API
 */
export function getParentExcalidrawAPI(): any {
  const parentWindow = getParentWindow();
  if (parentWindow && (parentWindow as any).excalidrawAPI) {
    return (parentWindow as any).excalidrawAPI;
  }
  return null;
}

const nextVersionNonce = (previous: unknown): number => {
  const previousNonce = Number.isSafeInteger(previous) ? previous : -1;
  let nonce = Math.floor(Math.random() * 0x7fffffff);
  if (nonce === previousNonce) nonce = nonce === 0 ? 1 : nonce - 1;
  return nonce;
};

const cloneConfig = (value: unknown): Record<string, any> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {}
);

const withUpdatedElementData = (
  element: any,
  customData: Record<string, any> | undefined,
) => ({
  ...element,
  customData,
  version: (Number.isFinite(element.version) ? element.version : 0) + 1,
  versionNonce: nextVersionNonce(element.versionNonce),
  updated: Date.now(),
});

export async function getElementData(
  elementId: string,
  blockId: string,
  canApply: () => boolean = () => true,
): Promise<SiyuanBlockData | null> {
  const api = getParentExcalidrawAPI();
  if (!api) return null;

  const element = api.getSceneElements().find((el : any) => el.id === elementId);
  if (element) {
    const content = await fetchBlockMarkdown(blockId);
    if (content === null) {
      // Keep the last known block data so a transient API failure does not
      // destroy the embedded element's cached content or configuration.
      return null;
    }

    const data: SiyuanBlockData = {
      blockId: blockId,
      content: OptimizeMarkdown(content),
      config: {},
    };

    const latestElement = api.getSceneElements().find(
      (sceneElement: any) => sceneElement.id === elementId,
    );
    if (!latestElement) return null;

    // A newer update request owns the scene. Let the caller keep its current
    // preview and discard this stale response.
    if (!canApply()) return null;

    const currentEmbedData = latestElement.customData?.embedSiyuan;
    data.config = cloneConfig(currentEmbedData?.config);
    if (!currentEmbedData
      || currentEmbedData.blockId !== data.blockId
      || currentEmbedData.content !== data.content) {
      if (!canApply()) return null;
      const elements = api.getSceneElements().map((sceneElement: any) => {
        if (sceneElement.id === elementId) {
          return withUpdatedElementData(sceneElement, {
            ...(sceneElement.customData || {}),
            embedSiyuan: data,
            embedIframeVersionNonce: nextVersionNonce(
              sceneElement.customData?.embedIframeVersionNonce,
            ),
          });
        }
        return sceneElement;
      });
      // The scene can change while the map is being built. Keep stale
      // iframe requests from writing over a newer scene update.
      if (!canApply()) return null;
      const currentSceneElement = api.getSceneElements().find(
        (sceneElement: any) => sceneElement.id === elementId,
      );
      if (
        !currentSceneElement ||
        currentSceneElement.version !== latestElement.version ||
        currentSceneElement.versionNonce !== latestElement.versionNonce ||
        currentSceneElement.updated !== latestElement.updated
      ) {
        // The scene changed while the block request was in flight. The caller
        // keeps the visible preview and retries against the current element.
        return null;
      }
      api.updateScene({ elements: elements });
    }

    return data;
  }
  return null;
}

/**
 * 更新父页面的元素数据
 */
export function updateElementData(elementId: string, blockData: SiyuanBlockData): void {
  const api = getParentExcalidrawAPI();
  if (!api) return;

  let didUpdate = false;
  const elements = api.getSceneElements().map((element: any) => {
    if (element.id === elementId) {
      const nextBlockData = {
        ...blockData,
        config: cloneConfig(blockData.config),
      };
      const currentBlockData = element.customData?.embedSiyuan;
      if (
        currentBlockData?.blockId === nextBlockData.blockId &&
        currentBlockData?.content === nextBlockData.content &&
        JSON.stringify(currentBlockData?.config || {}) ===
          JSON.stringify(nextBlockData.config || {})
      ) {
        return element;
      }
      didUpdate = true;
      return withUpdatedElementData(element, {
        ...(element.customData || {}),
        embedIframeVersionNonce: nextVersionNonce(
          element.customData?.embedIframeVersionNonce,
        ),
        embedSiyuan: nextBlockData,
      });
    }
    return element;
  });
  if (didUpdate) {
    api.updateScene({
      elements: elements,
    });
  }
}

/**
 * 从思源 API 获取块 Markdown 内容
 */
async function fetchBlockMarkdown(blockId: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/export/exportMdContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: blockId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    if (result.code === 0 && typeof result.data?.content === 'string') {
      return result.data.content;
    }
    console.error('Failed to fetch block markdown:', result.msg);
    return null;
  } catch (error) {
    console.error('Error fetching block markdown:', error);
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function OptimizeMarkdown(markdown: string): string {
  // 去掉frontmatter
  const frontMatterRegex = /^---[\s\S]*?\n---\n?/;
  if (frontMatterRegex.test(markdown)) {
    markdown = markdown.replace(frontMatterRegex, '').trim();
  }
  // 去掉文件名标题
  if (markdown.startsWith('# ')) {
    markdown = markdown.replace(/^# [^\n]*\n?/, '').trim();
  }
  // 修复所有附件链接
  markdown = markdown.replace(/(\[.*?\])\(assets\/([^)]*)\)/g, '$1(/assets/$2)');
  return markdown;
}
