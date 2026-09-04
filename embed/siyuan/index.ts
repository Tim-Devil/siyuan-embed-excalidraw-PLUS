import Vditor from 'vditor';
import 'vditor/dist/index.css';
import type { SiyuanBlockData } from './types';
import { getElementData, getParentWindow } from './utils';

// 获取 URL 参数
const urlParams = new URLSearchParams(window.location.search);
const elementId = urlParams.get('elementId');
const blockId = urlParams.get('blockId');
let currentBlockData: SiyuanBlockData | null = null;
let updateRequestSequence = 0;
let renderSequence = 0;
let removeButtonVisibilityListeners: (() => void) | null = null;

/**
 * 渲染思源块 Markdown 内容为静态 HTML
 */
async function renderBlock(
  blockData: SiyuanBlockData,
  requestId = updateRequestSequence,
): Promise<void> {
  const rootElement = document.getElementById('root');
  if (!rootElement) return;

  const currentRenderId = ++renderSequence;
  const previewContainer = document.createElement('div');
  previewContainer.className = 'vditor-reset';

  // 使用 Vditor.preview 渲染 Markdown
  try {
    await Vditor.preview(previewContainer, blockData.content, {
      mode: 'light',
      cdn: '/plugins/siyuan-embed-excalidraw-plus/embed/markdown/vditor',
      speech: {
        enable: false,
      },
    });
  } catch (error) {
    if (currentRenderId === renderSequence && requestId === updateRequestSequence) {
      throw error;
    }
    return;
  }

  // Only the latest completed render may replace the visible preview.
  if (
    currentRenderId !== renderSequence ||
    requestId !== updateRequestSequence ||
    !rootElement.isConnected
  ) return;

  previewContainer.id = 'preview';
  rootElement.replaceChildren(previewContainer);
}

/**
 * 更新按钮状态（聚焦时显示）
 */
function setupButtonVisibility(): void {
  const buttonContainer = document.getElementById('button-container');
  if (!buttonContainer) return;

  const showButtons = () => buttonContainer.classList.add('button-visible');
  const hideButtons = () => buttonContainer.classList.remove('button-visible');

  // 鼠标移入 iframe 时显示按钮
  document.addEventListener('mouseenter', showButtons);

  // 鼠标移出 iframe 时隐藏按钮
  document.addEventListener('mouseleave', hideButtons);
  removeButtonVisibilityListeners = () => {
    document.removeEventListener('mouseenter', showButtons);
    document.removeEventListener('mouseleave', hideButtons);
  };
}

/**
 * 更新按钮功能 - 重新获取 Markdown 数据并在内容变化时更新
 */
const handleUpdate = async (): Promise<void> => {
  if (!elementId || !blockId) return;
  const requestId = ++updateRequestSequence;

  try {
    const newBlockData = await getElementData(
      elementId,
      blockId,
      () => requestId === updateRequestSequence,
    );
    if (requestId !== updateRequestSequence) return;
    if (newBlockData === null) {
      console.error('Failed to fetch siyuan block');
      return;
    }

    const currentConfig = JSON.stringify(currentBlockData?.config ?? {});
    const newConfig = JSON.stringify(newBlockData.config ?? {});
    if (
      currentBlockData &&
      currentBlockData.blockId === newBlockData.blockId &&
      currentBlockData.content === newBlockData.content &&
      currentConfig === newConfig
    ) {
      return;
    }

    await renderBlock(newBlockData, requestId);
    if (requestId !== updateRequestSequence) return;
    currentBlockData = newBlockData;
  } catch (error) {
    console.error('Failed to update siyuan block', error);
  }
}

/**
 * 编辑按钮功能
 */
const handleEdit = (): void => {
  const frameRect = window.frameElement?.getBoundingClientRect();
  if (!blockId || !frameRect) return;

  // The parent Excalidraw frame adds its own offset. Pass the nested frame's
  // top-left point in the shape expected by the parent bridge.
  getParentWindow()?.triggleHoverBlock(blockId, {
    x: frameRect.left,
    y: frameRect.top,
  });
}

/**
 * 初始化按钮
 */
function initButtons(): void {
  const updateButton = document.getElementById('update-button');
  const editButton = document.getElementById('edit-button');

  if (updateButton) {
    updateButton.addEventListener('click', () => {
      void handleUpdate();
    });
  }

  if (editButton) {
    editButton.addEventListener('click', handleEdit);
  }

  setupButtonVisibility();
}

/**
 * 从父页面获取数据并初始化
 */
async function loadData(): Promise<boolean> {
  if (!elementId || !blockId) {
    console.error('Both elementId and blockId are required');
    return false;
  }

  const requestId = ++updateRequestSequence;
  try {
    const blockData = await getElementData(
      elementId,
      blockId,
      () => requestId === updateRequestSequence,
    );
    if (requestId !== updateRequestSequence) return false;
    if (blockData) {
      await renderBlock(blockData, requestId);
      currentBlockData = blockData;
      return true;
    }
    console.error('Failed to load block data for element:', elementId);
  } catch (error) {
    console.error('Failed to load block data for element:', elementId, error);
  }
  return false;
}

function showErrorMessage() {
  const rootElement = document.getElementById('root');
  if (rootElement) {
    rootElement.innerHTML = `
      <div style="display:flex;justify-content:center;align-items:center;height:100vh;color:#666;">
        <div style="text-align:center;">
          <p>Load failed</p>
          <p style="font-size:12px;">data not found</p>
        </div>
      </div>
    `;
  }
}

// 初始化
async function init() {
  const success = await loadData();
  if (!success) {
    // 初始化失败，显示错误信息
    showErrorMessage();
  }

  // 初始化按钮
  initButtons();
}

init();

// 页面卸载时清理
window.addEventListener('unload', () => {
  updateRequestSequence += 1;
  renderSequence += 1;
  removeButtonVisibilityListeners?.();
  removeButtonVisibilityListeners = null;
});
