import {
  Dialog,
  Plugin,
  getFrontend,
  fetchPost,
  fetchSyncPost,
  getAllEditor,
  getAllModels,
  openTab,
  Custom,
  Protyle,
} from "siyuan";
import "@/index.scss";
import PluginInfoString from '@/../plugin.json';
import {
  base64ToUnicode,
  unicodeToBase64,
  blobToDataURL,
  dataURLToBlob,
  HTMLToElement,
} from "@/utils";
import { matchHotKey, getCustomHotKey } from "./utils/hotkey";
import defaultImageContent from "@/default.json";

let PluginInfo = {
  version: '',
}
try {
  PluginInfo = PluginInfoString
} catch (err) {
  console.log('Plugin info parse error: ', err)
}
const {
  version,
} = PluginInfo

const PLUGIN_ID = "siyuan-embed-excalidraw-plus";
const STORAGE_NAME = "config.json";

const previewRefreshQueues = new Map<string, Promise<void>>();
let previewRefreshSequence = 0;

const resolveLocalURL = (value: string): URL => {
  const localValue = /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('/')
    ? value
    : `/${value}`;
  return new URL(localValue, window.location.origin + '/');
};

const getCanonicalImageURL = (value: unknown): URL | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = resolveLocalURL(value.trim());
    if (url.origin !== window.location.origin) return null;
    url.search = '';
    url.hash = '';
    return url;
  } catch (error) {
    return null;
  }
};

const imageUsesPath = (image: HTMLImageElement, pathname: string): boolean => {
  const values = [
    image.dataset.src,
    image.getAttribute('src'),
    image.currentSrc,
  ];
  return values.some((value) => {
    if (!value) return false;
    try {
      const url = resolveLocalURL(value);
      return url.origin === window.location.origin && url.pathname === pathname;
    } catch (error) {
      return false;
    }
  });
};

const refreshExcalidrawPreview = (message: any): void => {
  const canonicalURL = getCanonicalImageURL(message?.imageURL);
  if (!canonicalURL) return;

  const pathname = canonicalURL.pathname;
  const previousRefresh = previewRefreshQueues.get(pathname) || Promise.resolve();
  const currentRefresh = previousRefresh
    .catch(() => undefined)
    .then(async () => {
      const refreshToken = `${Date.now()}-${++previewRefreshSequence}`;
      const refreshedURL = new URL(canonicalURL.href);
      refreshedURL.searchParams.set('_excalidraw_refresh', refreshToken);
      const response = await fetch(refreshedURL.href, { cache: 'reload' });
      if (!response.ok) throw new Error(`preview refresh HTTP ${response.status}`);
      const refreshedBlob = await response.blob();
      if (refreshedBlob.size === 0) throw new Error('preview refresh returned an empty image');

      const srcset = `${refreshedURL.href} 1x, ${refreshedURL.href} 2x`;
      const images = Array.from(document.images).filter((image) => imageUsesPath(image, pathname));

      await Promise.all(images.map(async (image) => {
        image.setAttribute('srcset', srcset);
        try {
          await image.decode();
        } catch (error) {
          // Images that are still loading complete through their normal load event.
        }
      }));
    })
    .catch((error) => {
      console.warn('Excalidraw preview refresh failed', error);
    });

  previewRefreshQueues.set(pathname, currentRefresh);
  void currentRefresh.finally(() => {
    if (previewRefreshQueues.get(pathname) === currentRefresh) {
      previewRefreshQueues.delete(pathname);
    }
  });
};

export default class ExcalidrawPlugin extends Plugin {
  // Run as mobile
  public isMobile: boolean
  // Run in browser
  public isBrowser: boolean
  // Run as local
  public isLocal: boolean
  // Run in Electron
  public isElectron: boolean
  // Run in window
  public isInWindow: boolean
  public platform: SyFrontendTypes
  public readonly version = version

  private _mutationObserver;
  private _openMenuImageHandler;
  private _globalKeyDownHandler;

  private settingItems: SettingItem[];
  public EDIT_TAB_TYPE = "excalidraw-plus-edit-tab";

  async onload() {
    this.initMetaInfo();
    this.initSetting();

    this._mutationObserver = this.setAddImageBlockMuatationObserver(document.body, (blockElement: HTMLElement) => {
      const imageElement = blockElement.querySelector("img") as HTMLImageElement;
      if (imageElement) {
        const imageURL = imageElement.getAttribute("data-src");
        const imageURLRegex = /^assets\/(?:.+\/)?excalidraw-.+\.(?:svg|png)$/;
        if (!imageURLRegex.test(imageURL)) return;
        this.getExcalidrawImageInfo(imageURL, false).then((imageInfo) => {
          if (imageInfo) {
            if (this.data[STORAGE_NAME].labelDisplay !== "noLabel") this.updateAttrLabel(imageInfo, blockElement);

            const actionElement = blockElement.querySelector(".protyle-action") as HTMLElement;
            if (actionElement) {
              const editBtnElement = HTMLToElement(`<span aria-label="${this.i18n.editExcalidraw}" data-position="4north" class="ariaLabel protyle-icon"><svg><use xlink:href="#iconEdit"></use></svg></span>`);
              editBtnElement.addEventListener("click", (event: PointerEvent) => {
                event.preventDefault();
                event.stopPropagation();
                this.getExcalidrawImageInfo(imageElement.getAttribute("data-src"), false).then((imageInfo) => {
                  if (!imageInfo) return;
                  if (!this.isMobile && this.data[STORAGE_NAME].editWindow === 'tab') {
                    this.openEditTab(imageInfo);
                  } else {
                    this.openEditDialog(imageInfo);
                  }
                });
              });
              actionElement.insertAdjacentElement('afterbegin', editBtnElement);
              for (const child of actionElement.children) {
                child.classList.toggle('protyle-icon--only', false);
                child.classList.toggle('protyle-icon--first', false);
                child.classList.toggle('protyle-icon--last', false);
              }
              if (actionElement.children.length == 1) {
                actionElement.firstElementChild.classList.toggle('protyle-icon--only', true);
              }
              else if (actionElement.children.length > 1) {
                actionElement.firstElementChild.classList.toggle('protyle-icon--first', true);
                actionElement.lastElementChild.classList.toggle('protyle-icon--last', true);
              }
            }
          }
        });
      }
    });

    this.setupEditTab();

    this.protyleSlash = [{
      filter: ["excalidraw-plus", "excalidraw plus"],
      id: "excalidraw-plus",
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#iconImage"></use></svg><span class="b3-list-item__text">Excalidraw PLUS</span></div>`,
      callback: (protyle, nodeElement) => {
        this.newExcalidrawImage(protyle, (imageInfo) => {
          if (!this.isMobile && this.data[STORAGE_NAME].editWindow === 'tab') {
            this.openEditTab(imageInfo);
          } else {
            this.openEditDialog(imageInfo);
          }
        });
      },
    }];
    // 注册快捷键（都默认置空）
    this.addCommand({
      langKey: "createExcalidraw",
      hotkey: "",
      editorCallback: (protyle) => {
        this.newExcalidrawImage(protyle.getInstance(), (imageInfo) => {
          if (!this.isMobile && this.data[STORAGE_NAME].editWindow === 'tab') {
            this.openEditTab(imageInfo);
          } else {
            this.openEditDialog(imageInfo);
          }
        });
      },
    });

    this._openMenuImageHandler = this.openMenuImageHandler.bind(this);
    this.eventBus.on("open-menu-image", this._openMenuImageHandler);

    this._globalKeyDownHandler = this.globalKeyDownHandler.bind(this);
    document.documentElement.addEventListener("keydown", this._globalKeyDownHandler);

    this.reloadAllEditor();
    this.removeAllExcalidrawTab();
  }

  onunload() {
    if (this._mutationObserver) this._mutationObserver.disconnect();
    if (this._openMenuImageHandler) this.eventBus.off("open-menu-image", this._openMenuImageHandler);
    if (this._globalKeyDownHandler) document.documentElement.removeEventListener("keydown", this._globalKeyDownHandler);
    this.reloadAllEditor();
  }

  uninstall() {
    this.removeData(STORAGE_NAME);
    this.removeData("library.excalidrawlib");
    this.removeTempDir();
  }

  openSetting() {
    const dialogHTML = `
<div class="b3-dialog__content"></div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-type="cancel">${window.siyuan.languages.cancel}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-type="confirm">${window.siyuan.languages.save}</button>
</div>
    `;

    const dialog = new Dialog({
      title: this.displayName,
      content: dialogHTML,
      width: this.isMobile ? "92vw" : "768px",
      height: "80vh",
      hideCloseIcon: this.isMobile,
    });

    // 配置的处理拷贝自思源源码
    const contentElement = dialog.element.querySelector(".b3-dialog__content");
    this.settingItems.forEach(async (item) => {
      let html = "";
      let actionElement = item.actionElement;
      if (!item.actionElement && item.createActionElement) {
        actionElement = await item.createActionElement();
      }
      const tagName = actionElement?.classList.contains("b3-switch") ? "label" : "div";
      if (typeof item.direction === "undefined") {
        item.direction = (!actionElement || "TEXTAREA" === actionElement.tagName) ? "row" : "column";
      }
      if (item.direction === "row") {
        html = `<${tagName} class="b3-label">
    <div class="fn__block">
        ${item.title}
        ${item.description ? `<div class="b3-label__text">${item.description}</div>` : ""}
        <div class="fn__hr"></div>
    </div>
</${tagName}>`;
      } else {
        html = `<${tagName} class="fn__flex b3-label config__item">
    <div class="fn__flex-1">
        ${item.title}
        ${item.description ? `<div class="b3-label__text">${item.description}</div>` : ""}
    </div>
    <span class="fn__space${actionElement ? "" : " fn__none"}"></span>
</${tagName}>`;
      }
      contentElement.insertAdjacentHTML("beforeend", html);
      if (actionElement) {
        if (["INPUT", "TEXTAREA"].includes(actionElement.tagName)) {
          dialog.bindInput(actionElement as HTMLInputElement, () => {
            (dialog.element.querySelector(".b3-dialog__action [data-type='confirm']") as HTMLElement).dispatchEvent(new CustomEvent("click"));
          });
        }
        if (item.direction === "row") {
          contentElement.lastElementChild.lastElementChild.insertAdjacentElement("beforeend", actionElement);
          actionElement.classList.add("fn__block");
        } else {
          actionElement.classList.remove("fn__block");
          actionElement.classList.add("fn__flex-center", "fn__size200");
          contentElement.lastElementChild.insertAdjacentElement("beforeend", actionElement);
        }
      }
    });

    (dialog.element.querySelector(".b3-dialog__action [data-type='cancel']") as HTMLElement).addEventListener("click", () => {
      dialog.destroy();
    });
    (dialog.element.querySelector(".b3-dialog__action [data-type='confirm']") as HTMLElement).addEventListener("click", () => {
      this.data[STORAGE_NAME].labelDisplay = (dialog.element.querySelector("[data-type='labelDisplay']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].embedImageFormat = (dialog.element.querySelector("[data-type='embedImageFormat']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].fullscreenEdit = (dialog.element.querySelector("[data-type='fullscreenEdit']") as HTMLInputElement).checked;
      this.data[STORAGE_NAME].editWindow = (dialog.element.querySelector("[data-type='editWindow']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].themeMode = (dialog.element.querySelector("[data-type='themeMode']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].snippets = Array.from(dialog.element.querySelectorAll("[data-type='snippets'] input[data-id]:checked")).map(element => element.getAttribute("data-id"));
      this.data[STORAGE_NAME].enableAutoSave = (dialog.element.querySelector("[data-type='enableAutoSave']") as HTMLInputElement).checked;
      this.data[STORAGE_NAME].autoSaveInterval = (dialog.element.querySelector("[data-type='autoSaveInterval']") as HTMLInputElement).value;
      this.data[STORAGE_NAME].fullSaveDelay = (dialog.element.querySelector("[data-type='fullSaveDelay']") as HTMLInputElement).value;
      this.saveData(STORAGE_NAME, this.data[STORAGE_NAME]);
      this.reloadAllEditor();
      this.removeAllExcalidrawTab();
      dialog.destroy();
    });
  }

  private async initSetting() {
    await this.loadData(STORAGE_NAME);
    if (!this.data[STORAGE_NAME]) this.data[STORAGE_NAME] = {};
    if (typeof this.data[STORAGE_NAME].labelDisplay === 'undefined') this.data[STORAGE_NAME].labelDisplay = "showLabelOnHover";
    if (typeof this.data[STORAGE_NAME].embedImageFormat === 'undefined') this.data[STORAGE_NAME].embedImageFormat = "svg";
    if (typeof this.data[STORAGE_NAME].fullscreenEdit === 'undefined') this.data[STORAGE_NAME].fullscreenEdit = false;
    if (typeof this.data[STORAGE_NAME].editWindow === 'undefined') this.data[STORAGE_NAME].editWindow = 'dialog';
    if (typeof this.data[STORAGE_NAME].themeMode === 'undefined') this.data[STORAGE_NAME].themeMode = "themeLight";
    if (typeof this.data[STORAGE_NAME].snippets === 'undefined') this.data[STORAGE_NAME].snippets = [];
    if (typeof this.data[STORAGE_NAME].enableAutoSave === 'undefined') this.data[STORAGE_NAME].enableAutoSave = true;
    if (typeof this.data[STORAGE_NAME].autoSaveInterval === 'undefined') this.data[STORAGE_NAME].autoSaveInterval = 0;
    if (typeof this.data[STORAGE_NAME].fullSaveDelay === 'undefined') this.data[STORAGE_NAME].fullSaveDelay = 5;

    this.settingItems = [
      {
        title: this.i18n.labelDisplay,
        direction: "column",
        description: this.i18n.labelDisplayDescription,
        createActionElement: async () => {
          const options = ["noLabel", "showLabelAlways", "showLabelOnHover"];
          const optionsHTML = options.map(option => {
            const isSelected = String(option) === String(this.data[STORAGE_NAME].labelDisplay);
            return `<option value="${option}"${isSelected ? " selected" : ""}>${this.i18n[option]}</option>`;
          }).join("");
          return HTMLToElement(`<select class="b3-select fn__flex-center" data-type="labelDisplay">${optionsHTML}</select>`);
        },
      },
      {
        title: this.i18n.embedImageFormat,
        direction: "column",
        description: this.i18n.embedImageFormatDescription,
        createActionElement: async () => {
          const options = ["svg", "png"];
          const optionsHTML = options.map(option => {
            const isSelected = String(option) === String(this.data[STORAGE_NAME].embedImageFormat);
            return `<option value="${option}"${isSelected ? " selected" : ""}>${option}</option>`;
          }).join("");
          return HTMLToElement(`<select class="b3-select fn__flex-center" data-type="embedImageFormat">${optionsHTML}</select>`);
        },
      },
      {
        title: this.i18n.fullscreenEdit,
        direction: "column",
        description: this.i18n.fullscreenEditDescription,
        createActionElement: async () => {
          const element = HTMLToElement(`<input type="checkbox" class="b3-switch fn__flex-center" data-type="fullscreenEdit">`) as HTMLInputElement;
          element.checked = this.data[STORAGE_NAME].fullscreenEdit;
          return element;
        },
      },
      {
        title: this.i18n.editWindow,
        direction: "column",
        description: this.i18n.editWindowDescription,
        createActionElement: async () => {
          const options = ["dialog", "tab"];
          const optionsHTML = options.map(option => {
            const isSelected = String(option) === String(this.data[STORAGE_NAME].editWindow);
            return `<option value="${option}"${isSelected ? " selected" : ""}>${option}</option>`;
          }).join("");
          return HTMLToElement(`<select class="b3-select fn__flex-center" data-type="editWindow">${optionsHTML}</select>`);
        },
      },
      {
        title: this.i18n.themeMode,
        direction: "column",
        description: this.i18n.themeModeDescription,
        createActionElement: async () => {
          const options = ["themeLight", "themeDark", "themeOS"];
          const optionsHTML = options.map(option => {
            const isSelected = String(option) === String(this.data[STORAGE_NAME].themeMode);
            return `<option value="${option}"${isSelected ? " selected" : ""}>${window.siyuan.languages[option]}</option>`;
          }).join("");
          return HTMLToElement(`<select class="b3-select fn__flex-center" data-type="themeMode">${optionsHTML}</select>`);
        },
      },
      {
        title: this.i18n.enableAutoSave,
        direction: "column",
        description: this.i18n.enableAutoSaveDescription,
        createActionElement: async () => {
          const element = HTMLToElement(`<input type="checkbox" class="b3-switch fn__flex-center" data-type="enableAutoSave">`) as HTMLInputElement;
          element.checked = this.data[STORAGE_NAME].enableAutoSave;
          return element;
        },
      },
      {
        title: this.i18n.autoSaveInterval,
        direction: "column",
        description: this.i18n.autoSaveIntervalDescription,
        createActionElement: async () => {
          return HTMLToElement(`<input type="number" class="b3-text-field fn__flex-center" data-type="autoSaveInterval" min="0" step="0.5" value="${this.data[STORAGE_NAME].autoSaveInterval}">`);
        },
      },
      {
        title: this.i18n.fullSaveDelay,
        direction: "column",
        description: this.i18n.fullSaveDelayDescription,
        createActionElement: async () => {
          return HTMLToElement(`<input type="number" class="b3-text-field fn__flex-center" data-type="fullSaveDelay" min="0" step="0.5" value="${this.data[STORAGE_NAME].fullSaveDelay}">`);
        },
      },
      {
        title: this.i18n.snippets,
        direction: "row",
        description: this.i18n.snippetsDescription,
        createActionElement: async () => {
          const snippets = await this.getSnippets();
          const optionsHTML = snippets.map(snippet => {
            return `
<div class="fn__hr--small"></div>
<div class="fn__flex">
  <div class="b3-chip b3-chip--small ${snippet.type === 'css' ? "b3-chip--primary" : "b3-chip--secondary"}">${snippet.type.toUpperCase()}</div>
  <div class="fn__space"></div>
  <div class="fn__flex-1">${snippet.name}</div>
  <div class="fn__space"></div>
  <input type="checkbox" class="b3-switch fn__flex-center" data-id="${snippet.id}" />
</div>`;
          }).join("");
          const element = HTMLToElement(`<div class="fn__flex-center" data-type="snippets">${optionsHTML}</div>`);
          this.data[STORAGE_NAME].snippets.forEach(snippet => {
            const checkbox = element.querySelector(`[data-id="${snippet}"]`) as HTMLInputElement;
            if (checkbox) {
              checkbox.checked = true;
            }
          });
          return element;
        },
      },
    ];
  }

  private initMetaInfo() {
    const frontEnd = getFrontend();
    this.platform = frontEnd as SyFrontendTypes
    this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile";
    this.isBrowser = frontEnd.includes('browser');
    this.isLocal = location.href.includes('127.0.0.1') || location.href.includes('localhost');
    this.isInWindow = location.href.includes('window.html');

    try {
      require("@electron/remote")
        .require("@electron/remote/main");
      this.isElectron = true;
    } catch (err) {
      this.isElectron = false;
    }
  }

  public setAddImageBlockMuatationObserver(element: HTMLElement, callback: (blockElement: HTMLElement) => void): MutationObserver {
    const mutationObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const addedElement = node as HTMLElement;
              if (addedElement.matches("div[data-type='NodeParagraph']")) {
                if (addedElement.querySelector(".img[data-type='img'] img")) {
                  callback(addedElement as HTMLElement);
                }
              } else {
                addedElement.querySelectorAll("div[data-type='NodeParagraph']").forEach((blockElement: HTMLElement) => {
                  if (blockElement.querySelector(".img[data-type='img'] img")) {
                    callback(blockElement);
                  }
                })
              }
            }
          });
        }
      }
    });

    mutationObserver.observe(element, {
      childList: true,
      subtree: true
    });

    return mutationObserver;
  }

  public async getExcalidrawImageInfo(imageURL: string, reload: boolean): Promise<ExcalidrawImageInfo | null> {
    const imageURLRegex = /^assets\/.+\.(?:svg|png)$/;
    if (!imageURLRegex.test(imageURL)) return null;

    const imageContent = await this.getExcalidrawImage(imageURL, reload);
    if (!imageContent) return null;

    if (!base64ToUnicode(imageContent.split(',').pop()).includes("application/vnd.excalidraw+json")) return null;

    const imageInfo: ExcalidrawImageInfo = {
      imageURL: imageURL,
      data: imageContent,
      format: imageURL.endsWith(".svg") ? "svg" : "png",
    }
    return imageInfo;
  }

  public getPlaceholderImageContent(format: 'svg' | 'png'): string {
    let imageContent = defaultImageContent[format];
    return imageContent;
  }

  public newExcalidrawImage(protyle: Protyle, callback?: (imageInfo: ExcalidrawImageInfo) => void) {
    const format = this.data[STORAGE_NAME].embedImageFormat;
    const imageName = `excalidraw-image-${window.Lute.NewNodeID()}.${format}`;
    const placeholderImageContent = this.getPlaceholderImageContent(format);
    const blob = dataURLToBlob(placeholderImageContent);
    const file = new File([blob], imageName, { type: blob.type });
    const formData = new FormData();
    formData.append('path', `data/assets/${imageName}`);
    formData.append('file', file);
    formData.append('isDir', 'false');
    fetchPost('/api/file/putFile', formData, () => {
      const imageURL = `assets/${imageName}`;
      protyle.insert(`![](${imageURL})`);
      const imageInfo: ExcalidrawImageInfo = {
        imageURL: imageURL,
        data: placeholderImageContent,
        format: format,
      };
      if (callback) {
        callback(imageInfo);
      }
    });
  }

  public async getExcalidrawImage(imageURL: string, reload: boolean): Promise<string> {
    const response = await fetch(imageURL, { cache: reload ? 'reload' : 'default' });
    if (!response.ok) return "";
    const blob = await response.blob();
    return await blobToDataURL(blob);
  }

  public updateAttrLabel(imageInfo: ExcalidrawImageInfo, blockElement: HTMLElement) {
    if (!imageInfo) return;

    if (this.data[STORAGE_NAME].labelDisplay === "noLabel") return;

    const attrElement = blockElement.querySelector(".protyle-attr") as HTMLDivElement;
    if (attrElement) {
      const labelHTML = `<span>Excalidraw</span>`;
      let labelElement = attrElement.querySelector(".label--embed-excalidraw") as HTMLDivElement;
      if (labelElement) {
        labelElement.innerHTML = labelHTML;
      } else {
        labelElement = document.createElement("div");
        labelElement.classList.add("label--embed-excalidraw");
        if (this.data[STORAGE_NAME].labelDisplay === "showLabelAlways") {
          labelElement.classList.add("label--embed-excalidraw--always");
        }
        labelElement.innerHTML = labelHTML;
        attrElement.prepend(labelElement);
      }
    }
  }

  private openMenuImageHandler({ detail }) {
    const selectedElement = detail.element;
    const imageElement = selectedElement.querySelector("img") as HTMLImageElement;
    const imageURL = imageElement.dataset.src;
    this.getExcalidrawImageInfo(imageURL, true).then((imageInfo: ExcalidrawImageInfo) => {
      if (imageInfo) {
        window.siyuan.menus.menu.addItem({
          id: "edit-excalidraw",
          icon: 'iconEdit',
          label: `${this.i18n.editExcalidraw}`,
          index: 1,
          click: () => {
            if (!this.isMobile && this.data[STORAGE_NAME].editWindow === 'tab') {
              this.openEditTab(imageInfo);
            } else {
              this.openEditDialog(imageInfo);
            }
          }
        });
      }
    })
  }

  private getActiveCustomTab(type: string): Custom {
    const allCustoms = getAllModels().custom;
    const activeTabElement = document.querySelector(".layout__wnd--active .item--focus");
    if (activeTabElement) {
      const tabId = activeTabElement.getAttribute("data-id");
      for (const custom of allCustoms as any[]) {
        if (custom.type == this.name + type && custom.tab.headElement?.getAttribute('data-id') == tabId) {
          return custom;
        };
      }
    }
    return null;
  }

  private tabHotKeyEventHandler = (event: KeyboardEvent, custom?: Custom) => {
    // 恢复默认处理方式的快捷键
    if (custom) {
      const isGoToEditTabNext = matchHotKey(getCustomHotKey(window.siyuan.config.keymap.general.goToEditTabNext), event);
      const isGoToEditTabPrev = matchHotKey(getCustomHotKey(window.siyuan.config.keymap.general.goToEditTabPrev), event);
      const isGoToTabNext = matchHotKey(getCustomHotKey(window.siyuan.config.keymap.general.goToTabNext), event);
      const isGoToTabPrev = matchHotKey(getCustomHotKey(window.siyuan.config.keymap.general.goToTabPrev), event);
      if (isGoToEditTabNext || isGoToEditTabPrev || isGoToTabNext || isGoToTabPrev) {
        event.preventDefault();
        event.stopPropagation();
        const clonedEvent = new KeyboardEvent(event.type, event);
        window.dispatchEvent(clonedEvent);
      }
    }

    // 自定义处理方式的快捷键
    const isFullscreenHotKey = matchHotKey(getCustomHotKey(window.siyuan.config.keymap.editor.general.fullscreen), event);
    const isCloseTabHotKey = matchHotKey(getCustomHotKey(window.siyuan.config.keymap.general.closeTab), event);
    if (isFullscreenHotKey || isCloseTabHotKey) {
      if (!custom) custom = this.getActiveCustomTab(this.EDIT_TAB_TYPE);
      if (custom) {
        event.preventDefault();
        event.stopPropagation();

        if (isFullscreenHotKey) {
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            custom.element.requestFullscreen();
          }
        }
        if (isCloseTabHotKey) {
          custom.tab.close();
        }
      }
    }
  };

  private globalKeyDownHandler = (event: KeyboardEvent) => {
    // 如果是在代码编辑器里使用快捷键，则阻止冒泡 https://github.com/YuxinZhaozyx/siyuan-embed-tikz/issues/1
    if (document.activeElement.closest(".b3-dialog--open .excalidraw-edit-dialog")) {
      event.stopPropagation();
    }

    // 快捷键
    this.tabHotKeyEventHandler(event);
  };

  public setupEditTab() {
    const that = this;
    this.addTab({
      type: this.EDIT_TAB_TYPE,
      init() {
        const imageInfo: ExcalidrawImageInfo = this.data;
        const iframeID = encodeURIComponent(unicodeToBase64(`${PLUGIN_ID}-edit-tab-${imageInfo.imageURL}`));
        const editTabHTML = `
<div class="excalidraw-edit-tab">
    <iframe src="/plugins/siyuan-embed-excalidraw-plus/app/?lang=${window.siyuan.config.lang.replace('_', '-')}${that.isDarkMode() ? "&dark=1" : ""}&iframeID=${iframeID}&imageURL=${encodeURIComponent(imageInfo.imageURL)}&enableAutoSave=${that.data[STORAGE_NAME].enableAutoSave}&autoSaveInterval=${that.data[STORAGE_NAME].autoSaveInterval}&fullSaveDelay=${that.data[STORAGE_NAME].fullSaveDelay}"></iframe>
</div>`;
        this.element.innerHTML = editTabHTML;

        const iframe = this.element.querySelector("iframe");
        iframe.focus();

        const postMessage = (message: any) => {
          if (!iframe.contentWindow) return;
          iframe.contentWindow.postMessage(JSON.stringify(message), '*');
        };

        const closeTabNow = this.tab.close.bind(this.tab);
        let closeRequested = false;
        let iframeReady = false;
        let closeMessageSent = false;
        let closeRequestTimer: ReturnType<typeof setTimeout> | null = null;
        const closeRequestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const requestTabClose = () => {
          if (closeRequested) return;
          closeRequested = true;
          if (iframeReady && !closeMessageSent) {
            closeMessageSent = true;
            postMessage({ event: 'saveAndExit', requestId: closeRequestId });
          }
          closeRequestTimer = setTimeout(() => {
            closeRequested = false;
            closeMessageSent = false;
            closeRequestTimer = null;
            console.warn('Excalidraw tab close was canceled because saving did not finish');
          }, 30000);
        };
        (this.tab as any).close = requestTabClose;
        const tabCloseElement = this.tab.headElement?.querySelector('.item__close');
        const tabCloseClickHandler = (event: MouseEvent) => {
          if (this.tab.headElement?.classList.contains('item--pin')) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          requestTabClose();
        };
        tabCloseElement?.addEventListener('click', tabCloseClickHandler, true);
        const tabMiddleClickHandler = (event: MouseEvent) => {
          if (event.button !== 1 || this.tab.headElement?.classList.contains('item--pin')) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          requestTabClose();
        };
        this.tab.headElement?.addEventListener('mousedown', tabMiddleClickHandler, true);

        const keydownEventHandleer = (event: KeyboardEvent) => {
          that.tabHotKeyEventHandler(event, this);
        };
        const onInit = (message: any) => {
          iframe.contentWindow.addEventListener("keydown", keydownEventHandleer);
        }

        const onReady = (message: any) => {
          iframeReady = true;
          that.injectSnippetsToIframe(iframe);
          if (closeRequested && !closeMessageSent) {
            closeMessageSent = true;
            postMessage({ event: 'saveAndExit', requestId: closeRequestId });
          }
        }

        const onSave = (message: any) => {
          refreshExcalidrawPreview(message);
        }

        const onBrowseLibrary = (message: any) => {
          closeTabNow();
        };

        const onExit = (message: any) => {
          closeTabNow();
        };

        const onSaveFailed = (message: any) => {
          if (message.requestId !== closeRequestId) return;
          closeRequested = false;
          closeMessageSent = false;
          if (closeRequestTimer) {
            clearTimeout(closeRequestTimer);
            closeRequestTimer = null;
          }
          console.warn('Excalidraw tab close was canceled because saving failed');
        };

        const onTriggleHoverBlock = (message: any) => {
          if (message.blockID) {
            that.addFloatLayer({
              refDefs: [{ refID: message.blockID, defIDs: [] }],
              x: message.x,
              y: message.y,
              isBacklink: false
            });
          }
        }

        const messageEventHandler = (event) => {
          if (event.source !== iframe.contentWindow) return;
          if (event.data && event.data.length > 0) {
            try {
              var message = JSON.parse(event.data);
              if (message != null) {
                // console.log(message.event);
                if (message.event == "init") {
                  onInit(message);
                }
                else if (message.event == "ready") {
                  onReady(message);
                }
                else if (message.event == "save") {
                  onSave(message);
                }
                else if (message.event == "browseLibrary") {
                  onBrowseLibrary(message);
                }
                else if (message.event == "exit") {
                  onExit(message);
                }
                else if (message.event == "saveFailed") {
                  onSaveFailed(message);
                }
                else if (message.event == 'triggleHoverBlock') {
                  onTriggleHoverBlock(message);
                }
              }
            }
            catch (err) {
              console.error(err);
            }
          }
        };

        window.addEventListener("message", messageEventHandler);
        this.beforeDestroy = () => {
          window.removeEventListener("message", messageEventHandler);
          tabCloseElement?.removeEventListener('click', tabCloseClickHandler, true);
          this.tab.headElement?.removeEventListener('mousedown', tabMiddleClickHandler, true);
          (this.tab as any).close = closeTabNow;
          if (closeRequestTimer) clearTimeout(closeRequestTimer);
        };
      }
    });
  }

  public openEditTab(imageInfo: ExcalidrawImageInfo) {
    openTab({
      app: this.app,
      custom: {
        id: this.name + this.EDIT_TAB_TYPE,
        icon: "iconEdit",
        title: `${imageInfo.imageURL.split('/').pop()}`,
        data: imageInfo,
      }
    })
  }

  public openEditDialog(imageInfo: ExcalidrawImageInfo) {
    const iframeID = encodeURIComponent(unicodeToBase64(`${PLUGIN_ID}-edit-dialog-${imageInfo.imageURL}`));
    const editDialogHTML = `
<div class="excalidraw-edit-dialog">
    <div class="edit-dialog-header resize__move"></div>
    <div class="edit-dialog-container">
        <div class="edit-dialog-editor">
            <iframe src="/plugins/siyuan-embed-excalidraw-plus/app/?lang=${window.siyuan.config.lang.replace('_', '-')}&fullscreenBtn=1${this.isDarkMode() ? "&dark=1" : ""}&iframeID=${iframeID}&imageURL=${encodeURIComponent(imageInfo.imageURL)}&enableAutoSave=${this.data[STORAGE_NAME].enableAutoSave}&autoSaveInterval=${this.data[STORAGE_NAME].autoSaveInterval}&fullSaveDelay=${this.data[STORAGE_NAME].fullSaveDelay}"></iframe>
        </div>
        <div class="fn__hr--b"></div>
    </div>
</div>
    `;

    const dialogDestroyCallbacks = [];

    const dialog = new Dialog({
      content: editDialogHTML,
      width: this.isMobile ? "92vw" : "90vw",
      height: "80vh",
      hideCloseIcon: this.isMobile,
      destroyCallback: () => {
        dialogDestroyCallbacks.forEach(callback => callback());
      },
    });

    const iframe = dialog.element.querySelector("iframe") as HTMLIFrameElement;
    iframe.focus();

    const postMessage = (message: any) => {
      if (!iframe.contentWindow) return;
      iframe.contentWindow.postMessage(JSON.stringify(message), '*');
    };

    const destroyDialogNow = dialog.destroy.bind(dialog);
    let closeRequested = false;
    let iframeReady = false;
    let closeMessageSent = false;
    let closeRequestTimer: ReturnType<typeof setTimeout> | null = null;
    const closeRequestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const requestDialogClose = () => {
      if (closeRequested) return;
      closeRequested = true;
      if (iframeReady && !closeMessageSent) {
        closeMessageSent = true;
        postMessage({ event: 'saveAndExit', requestId: closeRequestId });
      }
      closeRequestTimer = setTimeout(() => {
        closeRequested = false;
        closeMessageSent = false;
        closeRequestTimer = null;
        console.warn('Excalidraw close was canceled because saving did not finish');
      }, 30000);
    };
    (dialog as any).destroy = requestDialogClose;

    const onInit = (message: any) => {}

    const onReady = (message: any) => {
      iframeReady = true;
      this.injectSnippetsToIframe(iframe);
      if (closeRequested && !closeMessageSent) {
        closeMessageSent = true;
        postMessage({ event: 'saveAndExit', requestId: closeRequestId });
      }
    }

    const onSave = (message: any) => {
      refreshExcalidrawPreview(message);
    }

    const onBrowseLibrary = (message: any) => {
      destroyDialogNow();
    };

    const onExit = (message: any) => {
      destroyDialogNow();
    };

    const onSaveFailed = (message: any) => {
      if (message.requestId !== closeRequestId) return;
      closeRequested = false;
      closeMessageSent = false;
      if (closeRequestTimer) {
        clearTimeout(closeRequestTimer);
        closeRequestTimer = null;
      }
      console.warn('Excalidraw close was canceled because saving failed');
    };

    const onTriggleHoverBlock = (message: any) => {
      if (message.blockID) {
        this.addFloatLayer({
          refDefs: [{ refID: message.blockID, defIDs: [] }],
          x: message.x,
          y: message.y,
          isBacklink: false
        });
      }
    }

    let isFullscreen = false;
    let dialogContainerStyle = {
      width: "100vw",
      height: "100vh",
      maxWidth: "unset",
      maxHeight: "unset",
      top: "auto",
      left: "auto",
    };
    const switchFullscreen = () => {
      const dialogContainerElement = dialog.element.querySelector('.b3-dialog__container') as HTMLElement;
      if (dialogContainerElement) {
        isFullscreen = !isFullscreen;
        if (isFullscreen) {
          dialogContainerStyle.width = dialogContainerElement.style.width;
          dialogContainerStyle.height = dialogContainerElement.style.height;
          dialogContainerStyle.maxWidth = dialogContainerElement.style.maxWidth;
          dialogContainerStyle.maxHeight = dialogContainerElement.style.maxHeight;
          dialogContainerStyle.top = dialogContainerElement.style.top;
          dialogContainerStyle.left = dialogContainerElement.style.left;
          dialogContainerElement.style.width = "100vw";
          dialogContainerElement.style.height = "100vh";
          dialogContainerElement.style.maxWidth = "unset";
          dialogContainerElement.style.maxHeight = "unset";
          dialogContainerElement.style.top = "0";
          dialogContainerElement.style.left = "0";
        } else {
          dialogContainerElement.style.width = dialogContainerStyle.width;
          dialogContainerElement.style.height = dialogContainerStyle.height;
          dialogContainerElement.style.maxWidth = dialogContainerStyle.maxWidth;
          dialogContainerElement.style.maxHeight = dialogContainerStyle.maxHeight;
          dialogContainerElement.style.top = dialogContainerStyle.top;
          dialogContainerElement.style.left = dialogContainerStyle.left;
        }
      }
    }
    if (this.data[STORAGE_NAME].fullscreenEdit) {
      switchFullscreen();
    }

    const messageEventHandler = (event) => {
      if (event.source !== iframe.contentWindow) return;
      if (event.data && event.data.length > 0) {
        try {
          var message = JSON.parse(event.data);
          if (message != null) {
            // console.log(message.event);
            if (message.event == "init") {
              onInit(message);
            }
            else if (message.event == "ready") {
              onReady(message);
            }
            else if (message.event == "save") {
              onSave(message);
            }
            else if (message.event == "browseLibrary") {
              onBrowseLibrary(message);
            }
            else if (message.event == "exit") {
              onExit(message);
            }
            else if (message.event == "saveFailed") {
              onSaveFailed(message);
            }
            else if (message.event == "toggleFullscreen") {
              switchFullscreen();
            }
            else if (message.event == 'triggleHoverBlock') {
              onTriggleHoverBlock(message);
            }
          }
        }
        catch (err) {
          console.error(err);
        }
      }
    };

    window.addEventListener("message", messageEventHandler);
    dialogDestroyCallbacks.push(() => {
      window.removeEventListener("message", messageEventHandler);
      if (closeRequestTimer) clearTimeout(closeRequestTimer);
      (dialog as any).destroy = destroyDialogNow;
    });
  }

  public reloadAllEditor() {
    getAllEditor().forEach((protyle) => { protyle.reload(false); });
  }

  public removeAllExcalidrawTab() {
    getAllModels().custom.forEach((custom: any) => {
      if (custom.type == this.name + this.EDIT_TAB_TYPE) {
        custom.tab?.close();
      }
    })
  }

  public isDarkMode(): boolean {
    return this.data[STORAGE_NAME].themeMode === 'themeDark' || (this.data[STORAGE_NAME].themeMode === 'themeOS' && window.siyuan.config.appearance.mode === 1);
  }

  private async getSnippets(snippetIDs?: string[]): Promise<ISnippet[]> {
    const response = await fetchSyncPost("/api/snippet/getSnippet", { type: "all", enabled: 2 });
    if (response.code !== 0) {
      console.warn(`${this.name}: get snippets failed`);
    }
    let snippets = response.data.snippets as ISnippet[];
    // 当指定snippetIDs时，只返回指定的snippets
    if (typeof snippetIDs !== 'undefined') {
      snippets = snippets.filter(snippet => this.data[STORAGE_NAME].snippets.includes(snippet.id));
    }
    return snippets;
  }

  private async injectSnippetsToIframe(iframe: HTMLIFrameElement) {
    const snippets = await this.getSnippets(this.data[STORAGE_NAME].snippets);
    snippets.forEach((snippet: ISnippet) => {
      let snippetElement: HTMLElement;
      if (snippet.type === 'css') {
        snippetElement = document.createElement('style');
        snippetElement.textContent = snippet.content;
      } else {
        snippetElement = document.createElement('script');
        snippetElement.setAttribute('type', 'text/javascript');
        snippetElement.textContent = snippet.content;
      }
      iframe.contentDocument?.head?.appendChild(snippetElement);
    });
  }

  private removeTempDir() {
    fetchPost("/api/file/removeFile", {path: `/temp/${PLUGIN_ID}`});
  }
}
