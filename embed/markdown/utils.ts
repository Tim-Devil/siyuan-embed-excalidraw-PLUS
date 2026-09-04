import type { MarkdownData, } from './types';

const cloneConfig = (value: unknown): Record<string, any> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {}
);

const nextVersionNonce = (previous: unknown): number => {
  const previousNonce = Number.isSafeInteger(previous) ? previous : -1;
  let nonce = Math.floor(Math.random() * 0x7fffffff);
  if (nonce === previousNonce) nonce = nonce === 0 ? 1 : nonce - 1;
  return nonce;
};

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

/**
 * 从父页面获取元素数据
 */
export function getElementData(elementId: string): MarkdownData | null {
  const api = getParentExcalidrawAPI();
  if (!api) return null;

  try {
    const element = api.getSceneElements().find((el : any) => el.id === elementId);
    if (element && element.customData?.embedMarkdown) {
      const data = element.customData.embedMarkdown as MarkdownData;
      return {
        content: typeof data.content === 'string' ? data.content : '',
        config: cloneConfig(data.config),
      };
    }
  } catch (error) {
    console.error('Failed to get element data:', error);
  }
  return null;
}

/**
 * 更新父页面的元素数据
 */
export function updateElementData(elementId: string, markdownData: MarkdownData): void {
  const api = getParentExcalidrawAPI();
  if (!api) return;

  try {
    let didUpdate = false;
    const elements = api.getSceneElements().map((element: any) => {
      if (element.id === elementId) {
        const nextMarkdownData = {
          content: typeof markdownData.content === 'string' ? markdownData.content : '',
          config: cloneConfig(markdownData.config),
        };
        const currentMarkdownData = element.customData?.embedMarkdown;
        if (
          currentMarkdownData?.content === nextMarkdownData.content &&
          JSON.stringify(currentMarkdownData?.config || {}) ===
            JSON.stringify(nextMarkdownData.config || {})
        ) {
          return element;
        }

        didUpdate = true;
        return {
          ...element,
          customData: {
            ...(element.customData || {}),
            embedMarkdown: nextMarkdownData,
            embedIframeVersionNonce: nextVersionNonce(
              element.customData?.embedIframeVersionNonce,
            ),
          },
          version: (Number.isFinite(element.version) ? element.version : 0) + 1,
          versionNonce: nextVersionNonce(element.versionNonce),
          updated: Date.now(),
        };
      }
      return element;
    });
    if (didUpdate) {
      api.updateScene({
        elements: elements,
      });
    }
  } catch (error) {
    console.error('Failed to update element data:', error);
  }
}
