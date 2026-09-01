import Vditor from 'vditor';
import 'vditor/dist/index.css';
import type { MarkdownData } from './types';
import { updateElementData, getElementData } from './utils';
import { debounce } from 'lodash';

// 获取 URL 参数
const urlParams = new URLSearchParams(window.location.search);
const elementId = urlParams.get('elementId');

let vditor: Vditor | null = null;
let currentMarkdownData: MarkdownData | null = null;

/**
 * 初始化 Vditor 编辑器
 */
function initVditor(markdownData: MarkdownData) {
  currentMarkdownData = markdownData;

  vditor = new Vditor('root', {
    // 基础配置
    height: '100%',
    mode: 'ir',
    cdn: '/plugins/siyuan-embed-excalidraw-plus/embed/markdown/vditor',

    // 工具栏配置
    toolbar: [
      'emoji',
      'headings',
      'bold',
      'italic',
      'strike',
      'link',
      '|',
      'list',
      'ordered-list',
      'check',
      'outdent',
      'indent',
      '|',
      'quote',
      'line',
      'code',
      'inline-code',
      'table',
      '|',
      'insert-before',
      'insert-after',
      '|',
      'undo',
      'redo',
      '|',
      'edit-mode',
      'content-theme',
      'code-theme',
      '|',
      'both',
      'reset',
    ],

    toolbarConfig: {
      hide: true,
      pin: false,
    },

    // 缓存配置
    cache: {
      enable: false, // 必须禁止以避免多个markdown编辑器间通过localstorage共享初始数据
    },

    // 输入回调 - 直接更新父页面数据
    input: debounce((value: string) => {
      if (elementId && currentMarkdownData) {
        currentMarkdownData.content = value;
        updateElementData(elementId, currentMarkdownData);
      }
    }, 300),

    // 初始化完成回调
    after: () => {
      // 设置初始内容
      if (vditor && currentMarkdownData?.content) {
        vditor.setValue(currentMarkdownData.content);
      }
    },
  });
}

/**
 * 从父页面获取数据并初始化
 */
function loadData(): boolean {
  if (!elementId) {
    console.error('No elementId provided');
    return false;
  }

  const markdownData = getElementData(elementId);
  if (markdownData) {
    currentMarkdownData = markdownData;
    initVditor(markdownData);
  } else {
    console.error('Failed to load markdown data for element:', elementId);
    return false;
  }
  return true;
}

// 直接从父页面获取数据并初始化
if (!loadData()) {
  // 没有 elementId，显示错误信息
  document.getElementById('root')!.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;height:100vh;color:#666;">
      <div style="text-align:center;">
        <p>Load fail</p>
        <p style="font-size:12px;">Please contract developer</p>
      </div>
    </div>
  `;
}

// 页面卸载时清理
window.addEventListener('unload', () => {
  if (vditor) {
    vditor.destroy();
  }
});
