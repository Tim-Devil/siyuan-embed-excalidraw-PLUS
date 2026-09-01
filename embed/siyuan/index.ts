import Vditor from 'vditor';
import 'vditor/dist/index.css';
import type { SiyuanBlockData } from './types';
import { getElementData, getParentWindow, updateElementData } from './utils';

// 获取 URL 参数
const urlParams = new URLSearchParams(window.location.search);
const elementId = urlParams.get('elementId');
const blockId = urlParams.get('blockId');
let currentBlockData: SiyuanBlockData | null = null;
let vditorPreviewElement: HTMLElement | null = null;

/**
 * 渲染思源块 Markdown 内容为静态 HTML
 */
async function renderBlock(blockData: SiyuanBlockData): Promise<void> {
  const rootElement = document.getElementById('root');
  if (!rootElement) return;

  // 清空现有内容
  rootElement.innerHTML = '';

  // 创建预览容器
  const previewContainer = document.createElement('div');
  previewContainer.id = 'preview';
  previewContainer.className = 'vditor-reset';
  rootElement.appendChild(previewContainer);

  // 使用 Vditor.preview 渲染 Markdown
  Vditor.preview(previewContainer, blockData.content, {
    mode: 'light',
    cdn: '/plugins/siyuan-embed-excalidraw-plus/embed/markdown/vditor',
    speech: {
      enable: false,
    },
  });

  vditorPreviewElement = previewContainer;
}

/**
 * 更新按钮状态（聚焦时显示）
 */
function setupButtonVisibility(): void {
  const buttonContainer = document.getElementById('button-container');
  if (!buttonContainer) return;

  // 鼠标移入 iframe 时显示按钮
  document.addEventListener('mouseenter', () => {
    buttonContainer.classList.toggle('button-visible', true);
  });

  // 鼠标移出 iframe 时隐藏按钮
  document.addEventListener('mouseleave', () => {
    buttonContainer.classList.toggle('button-visible', false);
  });
}

/**
 * 更新按钮功能 - 重新获取 Markdown 数据并在内容变化时更新
 */
const handleUpdate = async (): Promise<void> => {
  if (!elementId || !blockId) return;

  const newBlockData = await getElementData(elementId, blockId);
  if (newBlockData === null) {
    console.error('Failed to fetch siyuan block');
    showErrorMessage();
    return;
  }

  // 判断内容是否变化
  if (currentBlockData && currentBlockData.content === newBlockData.content) {
    console.log('No changes detected');
  }

  // 更新数据
  currentBlockData = newBlockData;
  
  // 重新渲染
  await renderBlock(currentBlockData);
  updateElementData(elementId, currentBlockData);
}

/**
 * 编辑按钮功能
 */
const handleEdit = (): void => {
  if (blockId) {
    getParentWindow()?.triggleHoverBlock(blockId, window.frameElement!.getBoundingClientRect())
  }
}

/**
 * 初始化按钮
 */
function initButtons(): void {
  const updateButton = document.getElementById('update-button');
  const editButton = document.getElementById('edit-button');

  if (updateButton) {
    updateButton.addEventListener('click', handleUpdate);
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
  if (!elementId && !blockId) {
    console.error('No elementId or blockId provided');
    return false;
  }

  // 如果有 elementId，从父页面获取数据
  if (elementId && blockId) {
    const blockData = await getElementData(elementId, blockId);
    if (blockData) {
      currentBlockData = blockData;
      await renderBlock(blockData);
      return true;
    }
    console.error('Failed to load block data for element:', elementId);
    return false;
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
  vditorPreviewElement = null;
});
