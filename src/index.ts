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
  base64ToArray,
  unicodeToBase64,
  blobToDataURL,
  dataURLToBlob,
  HTMLToElement,
  escapeHTML,
  locatePNGtEXt,
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
const TEXT_STYLE_STORAGE_KEY = `${PLUGIN_ID}:text-style:v1`;
const LOCAL_FONT_STORAGE_KEY = `${PLUGIN_ID}:local-fonts:v1`;
const CLOSE_SAVE_TIMEOUT_MS = 60000;
const MAX_PREVIEW_REFRESH_TOKENS = 256;

const parseNonNegativeNumber = (value: unknown, fallback: number): number => {
  const candidate = typeof value === "string" ? value.trim() : value;
  if (candidate === "") return fallback;
  const parsed = typeof candidate === "number" ? candidate : Number(candidate);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const normalizeAssetImagePath = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  const candidate = value.trim();
  try {
    const url = new URL(
      candidate,
      candidate.startsWith("/") ? window.location.origin : `${window.location.origin}/`,
    );
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/assets/")) {
      return "";
    }
    return url.pathname.slice(1);
  } catch (error) {
    return "";
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

const putFile = async (formData: FormData, timeoutMs = 30000): Promise<void> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/file/putFile", {
      method: "POST",
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

    if (!response.ok) {
      throw new Error(`putFile HTTP ${response.status}`);
    }
    if (result && typeof result.code === "number" && result.code !== 0) {
      throw new Error(`putFile API ${result.code}: ${result.msg || "unknown error"}`);
    }
  } finally {
    window.clearTimeout(timeout);
  }
};

const previewRefreshQueues = new Map<string, Promise<void>>();
const previewRefreshTokens = new Map<string, string>();
let previewRefreshSequence = 0;
let previewRefreshLifecycle = 0;

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

const IMAGE_SOURCE_ATTRIBUTES = [
  'src',
  'data-src',
  'data-original',
  'data-lazy-src',
] as const;
const IMAGE_SRCSET_ATTRIBUTES = ['srcset', 'data-srcset'] as const;

const getSourceSetValues = (sourceSet: string | null): string[] => (
  (sourceSet || '')
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter((value): value is string => Boolean(value))
);

const getImageSourceValues = (
  image: HTMLImageElement | null | undefined,
): string[] => {
  if (!image) return [];

  return [
    ...IMAGE_SOURCE_ATTRIBUTES.map((attribute) => image.getAttribute(attribute)),
    image.currentSrc,
    ...IMAGE_SRCSET_ATTRIBUTES.flatMap((attribute) =>
      getSourceSetValues(image.getAttribute(attribute))),
  ].filter((value): value is string => Boolean(value));
};

const getCanonicalImageElementURLs = (image: HTMLImageElement): URL[] => {
  const urls: URL[] = [];
  for (const value of getImageSourceValues(image)) {
    const url = getCanonicalImageURL(value);
    if (url && !urls.some((item) => item.href === url.href)) {
      urls.push(url);
    }
  }
  return urls;
};

const isExcalidrawAssetPath = (pathname: string): boolean =>
  /^\/assets\/(?:.+\/)?excalidraw-.+\.(?:svg|png)$/i.test(pathname);

const getExcalidrawImagePath = (
  image: HTMLImageElement | null | undefined,
): string => {
  for (const value of getImageSourceValues(image)) {
    const imagePath = normalizeAssetImagePath(value);
    if (/^assets\/(?:.+\/)?excalidraw-.+\.(?:svg|png)$/i.test(imagePath)) {
      return imagePath;
    }
  }
  return "";
};

const imageUsesPath = (
  image: HTMLImageElement | null | undefined,
  pathname: string,
): boolean => {
  return getImageSourceValues(image).some((value) => {
    if (!value) return false;
    try {
      const url = resolveLocalURL(value);
      return url.origin === window.location.origin && url.pathname === pathname;
    } catch (error) {
      return false;
    }
  });
};

const getCanonicalImageElementURL = (image: HTMLImageElement): URL | null => {
  const urls = getCanonicalImageElementURLs(image);
  return urls.find((url) => previewRefreshTokens.has(url.pathname))
    ?? urls.find((url) => isExcalidrawAssetPath(url.pathname))
    ?? urls[0]
    ?? null;
};

const rememberPreviewRefreshToken = (pathname: string, token: string): void => {
  previewRefreshTokens.delete(pathname);
  previewRefreshTokens.set(pathname, token);
  while (previewRefreshTokens.size > MAX_PREVIEW_REFRESH_TOKENS) {
    const oldestPath = previewRefreshTokens.keys().next().value;
    if (typeof oldestPath !== 'string') break;
    previewRefreshTokens.delete(oldestPath);
  }
};

const setImageRefreshSource = (
  image: HTMLImageElement,
  canonicalURL: URL,
  refreshToken: string,
): boolean => {
  const getRefreshedURL = (value: string | null): URL | null => {
    if (!value) return null;
    try {
      const candidateURL = resolveLocalURL(value);
      if (
        candidateURL.origin !== canonicalURL.origin ||
        candidateURL.pathname !== canonicalURL.pathname
      ) {
        return null;
      }
      candidateURL.hash = '';
      candidateURL.searchParams.set('_excalidraw_refresh', refreshToken);
      return candidateURL;
    } catch (error) {
      return null;
    }
  };

  const refreshedURL = getRefreshedURL(image.getAttribute('src'))
    || (() => {
      const fallbackURL = new URL(canonicalURL.href);
      fallbackURL.searchParams.set('_excalidraw_refresh', refreshToken);
      return fallbackURL;
    })();
  let didChange = false;
  const updateAttribute = (attribute: string, value: string): void => {
    if (image.getAttribute(attribute) === value) return;
    image.setAttribute(attribute, value);
    didChange = true;
  };

  updateAttribute('src', refreshedURL.href);

  // SiYuan keeps the original URL in lazy-loading attributes. Updating only
  // `src` lets a later lazy-load pass restore the stale preview.
  for (const attribute of IMAGE_SOURCE_ATTRIBUTES) {
    if (attribute === 'src') continue;
    const value = image.getAttribute(attribute);
    const nextURL = getRefreshedURL(value);
    if (nextURL) updateAttribute(attribute, nextURL.href);
  }

  for (const attribute of IMAGE_SRCSET_ATTRIBUTES) {
    const sourceSet = image.getAttribute(attribute);
    if (!sourceSet) continue;
    const refreshedSourceSet = sourceSet
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        const candidateURL = getRefreshedURL(parts.shift() || null);
        if (!candidateURL) return candidate.trim();
        return [candidateURL.href, ...parts].join(' ');
      })
      .filter(Boolean)
      .join(', ');
    updateAttribute(attribute, refreshedSourceSet);
  }

  return didChange;
};

const applyPendingPreviewRefresh = (image: HTMLImageElement): boolean => {
  if (previewRefreshTokens.size === 0) return false;
  const canonicalURL = getCanonicalImageElementURL(image);
  if (!canonicalURL) return false;
  const refreshToken = previewRefreshTokens.get(canonicalURL.pathname);
  return refreshToken
    ? setImageRefreshSource(image, canonicalURL, refreshToken)
    : false;
};

const refreshExcalidrawPreview = (message: any): void => {
  const canonicalURL = getCanonicalImageURL(message?.imageURL);
  if (!canonicalURL) return;

  const pathname = canonicalURL.pathname;
  const lifecycle = previewRefreshLifecycle;
  const previousRefresh = previewRefreshQueues.get(pathname) || Promise.resolve();
  const currentRefresh = previousRefresh
    .catch(() => undefined)
    .then(async () => {
      if (lifecycle !== previewRefreshLifecycle) return;
      const refreshToken = `${Date.now()}-${++previewRefreshSequence}`;
      const refreshedURL = new URL(canonicalURL.href);
      refreshedURL.searchParams.set('_excalidraw_refresh', refreshToken);
      const { response, blob: refreshedBlob } = await fetchBlobWithTimeout(
        refreshedURL.href,
        { cache: 'reload' },
      );
      if (!response.ok) throw new Error(`preview refresh HTTP ${response.status}`);
      if (refreshedBlob.size === 0) throw new Error('preview refresh returned an empty image');
      if (lifecycle !== previewRefreshLifecycle) return;

      rememberPreviewRefreshToken(pathname, refreshToken);
      const images = Array.from(document.images).filter((image) => imageUsesPath(image, pathname));

      await Promise.all(images.map(async (image) => {
        setImageRefreshSource(image, canonicalURL, refreshToken);
        try {
          await image.decode?.();
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
  private _imageLoadHandler;
  private _snippetInjectionInFlight = new WeakSet<HTMLIFrameElement>();

  private settingItems: SettingItem[];
  public EDIT_TAB_TYPE = "excalidraw-plus-edit-tab";

  async onload() {
    this.initMetaInfo();
    await this.initSetting();

    this._mutationObserver = this.setAddImageBlockMuatationObserver(document.body, (blockElement: HTMLElement) => {
      const imageElement = Array.from(blockElement.querySelectorAll<HTMLImageElement>("img"))
        .find((image) => Boolean(getExcalidrawImagePath(image)));
      if (imageElement) {
        const imageURL = getExcalidrawImagePath(imageElement);
        if (!imageURL) return;
        const refreshed = applyPendingPreviewRefresh(imageElement);
        this.getExcalidrawImageInfo(imageURL, refreshed).then((imageInfo) => {
          const currentImageElement = Array.from(
            blockElement.querySelectorAll<HTMLImageElement>("img"),
          ).find((image) => getExcalidrawImagePath(image) === imageURL) ?? null;
          if (
            imageInfo &&
            blockElement.isConnected &&
            getExcalidrawImagePath(currentImageElement) === imageURL
          ) {
            this.updateAttrLabel(imageInfo, blockElement);

            const actionElement = blockElement.querySelector(".protyle-action") as HTMLElement;
            if (actionElement) {
              const existingEditButton = actionElement.querySelector(
                '[data-excalidraw-plus-edit], .excalidraw-plus-edit-button',
              );
              if (!existingEditButton) {
                const editBtnElement = HTMLToElement(`<span aria-label="${this.i18n.editExcalidraw}" data-excalidraw-plus-edit="true" data-position="4north" class="ariaLabel protyle-icon excalidraw-plus-edit-button"><svg><use xlink:href="#iconEdit"></use></svg></span>`);
                editBtnElement.addEventListener("click", (event: PointerEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // Resolve the image at click time so a refreshed block never
                  // opens the URL captured during the first mutation.
                  const currentImageElement = Array.from(
                    blockElement.querySelectorAll<HTMLImageElement>("img"),
                  ).find((image) => Boolean(getExcalidrawImagePath(image))) ?? null;
                  const imageURL = getExcalidrawImagePath(
                    currentImageElement || blockElement.querySelector("img"),
                  );
                  if (!imageURL) return;
                  this.getExcalidrawImageInfo(imageURL, false).then((imageInfo) => {
                    if (!imageInfo) return;
                    if (!this.isMobile && this.data[STORAGE_NAME].editWindow === 'tab') {
                      this.openEditTab(imageInfo);
                    } else {
                      this.openEditDialog(imageInfo);
                    }
                  }).catch((error) => {
                    console.warn(`${this.name}: failed to open Excalidraw image`, error);
                  });
                });
                actionElement.insertAdjacentElement('afterbegin', editBtnElement);
              }
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
        }).catch((error) => {
          console.warn(`${this.name}: failed to inspect image block`, error);
        });
      }
    });
    this._imageLoadHandler = (event: Event) => {
      if (event.target instanceof HTMLImageElement) {
        applyPendingPreviewRefresh(event.target);
      }
    };
    document.addEventListener('load', this._imageLoadHandler, true);

    this.setupEditTab();

    this.protyleSlash = [{
      filter: ["excalidraw-plus", "excalidraw plus"],
      id: "excalidraw-plus",
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#iconImage"></use></svg><span class="b3-list-item__text">Excalidraw PLUS</span></div>`,
      callback: (protyle) => {
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
    previewRefreshLifecycle += 1;
    if (this._mutationObserver) this._mutationObserver.disconnect();
    if (this._openMenuImageHandler) this.eventBus.off("open-menu-image", this._openMenuImageHandler);
    if (this._globalKeyDownHandler) document.documentElement.removeEventListener("keydown", this._globalKeyDownHandler);
    if (this._imageLoadHandler) document.removeEventListener('load', this._imageLoadHandler, true);
    previewRefreshTokens.clear();
    previewRefreshQueues.clear();
    this.reloadAllEditor();
  }

  uninstall() {
    this.removeData(STORAGE_NAME);
    this.removeData("library.excalidrawlib");
    localStorage.removeItem(TEXT_STYLE_STORAGE_KEY);
    localStorage.removeItem(LOCAL_FONT_STORAGE_KEY);
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
    const confirmElement = dialog.element.querySelector(
      ".b3-dialog__action [data-type='confirm']",
    ) as HTMLButtonElement;
    const cancelElement = dialog.element.querySelector(
      ".b3-dialog__action [data-type='cancel']",
    ) as HTMLElement;
    if (!contentElement || !confirmElement || !cancelElement) return;

    confirmElement.disabled = true;
    cancelElement.addEventListener("click", () => {
      dialog.destroy();
    });

    const populateSettings = async () => {
      for (const item of this.settingItems) {
        if (!dialog.element.isConnected) return;
        let html = "";
        let actionElement = item.actionElement;
        if (!item.actionElement && item.createActionElement) {
          actionElement = await item.createActionElement();
        }
        if (!dialog.element.isConnected) return;
        const tagName = actionElement?.classList.contains("b3-switch") ? "label" : "div";
        const direction = item.direction
          ?? ((!actionElement || "TEXTAREA" === actionElement.tagName) ? "row" : "column");
        if (direction === "row") {
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
        const itemElement = contentElement.lastElementChild;
        if (actionElement && itemElement) {
          if (["INPUT", "TEXTAREA"].includes(actionElement.tagName)) {
            dialog.bindInput(actionElement as HTMLInputElement, () => {
              confirmElement.dispatchEvent(new CustomEvent("click"));
            });
          }
          if (direction === "row") {
            itemElement.lastElementChild?.insertAdjacentElement("beforeend", actionElement);
            actionElement.classList.add("fn__block");
          } else {
            actionElement.classList.remove("fn__block");
            actionElement.classList.add("fn__flex-center", "fn__size200");
            itemElement.insertAdjacentElement("beforeend", actionElement);
          }
        }
      }
    };

    const previousSettings = {
      ...this.data[STORAGE_NAME],
      snippets: [...this.data[STORAGE_NAME].snippets],
    };
    confirmElement.addEventListener("click", async () => {
      if (confirmElement.disabled) return;
      confirmElement.disabled = true;
      this.data[STORAGE_NAME].labelDisplay = (dialog.element.querySelector("[data-type='labelDisplay']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].embedImageFormat = (dialog.element.querySelector("[data-type='embedImageFormat']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].fullscreenEdit = (dialog.element.querySelector("[data-type='fullscreenEdit']") as HTMLInputElement).checked;
      this.data[STORAGE_NAME].editWindow = (dialog.element.querySelector("[data-type='editWindow']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].themeMode = (dialog.element.querySelector("[data-type='themeMode']") as HTMLSelectElement).value;
      this.data[STORAGE_NAME].snippets = Array.from(
        dialog.element.querySelectorAll("[data-type='snippets'] input[data-id]:checked"),
      )
        .map(element => element.getAttribute("data-id"))
        .filter((id): id is string => Boolean(id));
      this.data[STORAGE_NAME].enableAutoSave = (dialog.element.querySelector("[data-type='enableAutoSave']") as HTMLInputElement).checked;
      this.data[STORAGE_NAME].rememberTextStyle = (dialog.element.querySelector("[data-type='rememberTextStyle']") as HTMLInputElement).checked;
      this.data[STORAGE_NAME].autoSaveInterval = parseNonNegativeNumber(
        (dialog.element.querySelector("[data-type='autoSaveInterval']") as HTMLInputElement).value,
        previousSettings.autoSaveInterval,
      );
      this.data[STORAGE_NAME].fullSaveDelay = parseNonNegativeNumber(
        (dialog.element.querySelector("[data-type='fullSaveDelay']") as HTMLInputElement).value,
        previousSettings.fullSaveDelay,
      );
      try {
        await this.saveData(STORAGE_NAME, this.data[STORAGE_NAME]);
        if (!this.data[STORAGE_NAME].rememberTextStyle) localStorage.removeItem(TEXT_STYLE_STORAGE_KEY);
        this.reloadAllEditor();
        this.removeAllExcalidrawTab();
        dialog.destroy();
      } catch (error) {
        this.data[STORAGE_NAME] = previousSettings;
        confirmElement.disabled = false;
        console.warn(`${this.name}: failed to save settings`, error);
      }
    });

    let settingsReady = false;
    void populateSettings()
      .then(() => {
        settingsReady = true;
      })
      .catch((error) => {
        console.warn(`${this.name}: failed to build settings`, error);
      })
      .finally(() => {
        if (dialog.element.isConnected) confirmElement.disabled = !settingsReady;
      });
  }

  private async initSetting() {
    try {
      await this.loadData(STORAGE_NAME);
    } catch (error) {
      console.warn(`${this.name}: failed to load settings; using defaults`, error);
    }
    if (!this.data || typeof this.data !== "object") this.data = {};
    const storedSettings = this.data[STORAGE_NAME];
    if (!storedSettings || typeof storedSettings !== "object" || Array.isArray(storedSettings)) {
      this.data[STORAGE_NAME] = {};
    }
    const settings = this.data[STORAGE_NAME] as Record<string, any>;
    settings.labelDisplay = ["noLabel", "showLabelAlways", "showLabelOnHover"].includes(settings.labelDisplay)
      ? settings.labelDisplay
      : "showLabelOnHover";
    settings.embedImageFormat = ["svg", "png"].includes(settings.embedImageFormat)
      ? settings.embedImageFormat
      : "svg";
    settings.fullscreenEdit = typeof settings.fullscreenEdit === "boolean" ? settings.fullscreenEdit : false;
    settings.editWindow = ["dialog", "tab"].includes(settings.editWindow) ? settings.editWindow : "dialog";
    settings.themeMode = ["themeLight", "themeDark", "themeOS"].includes(settings.themeMode)
      ? settings.themeMode
      : "themeLight";
    settings.snippets = Array.isArray(settings.snippets)
      ? settings.snippets.filter((snippet: unknown): snippet is string => typeof snippet === "string")
      : [];
    settings.enableAutoSave = typeof settings.enableAutoSave === "boolean" ? settings.enableAutoSave : true;
    settings.rememberTextStyle = typeof settings.rememberTextStyle === "boolean" ? settings.rememberTextStyle : false;
    settings.autoSaveInterval = parseNonNegativeNumber(settings.autoSaveInterval, 0);
    settings.fullSaveDelay = parseNonNegativeNumber(settings.fullSaveDelay, 5);

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
        title: this.i18n.rememberTextStyle,
        direction: "column",
        description: this.i18n.rememberTextStyleDescription,
        createActionElement: async () => {
          const element = HTMLToElement(`<input type="checkbox" class="b3-switch fn__flex-center" data-type="rememberTextStyle">`) as HTMLInputElement;
          element.checked = this.data[STORAGE_NAME].rememberTextStyle;
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
          if (!snippets) {
            throw new Error("Unable to load SiYuan snippets");
          }
          const optionsHTML = snippets.map(snippet => {
            const snippetId = typeof snippet.id === "string" ? snippet.id : "";
            const snippetName = typeof snippet.name === "string" ? snippet.name : "";
            return `
<div class="fn__hr--small"></div>
<div class="fn__flex">
  <div class="b3-chip b3-chip--small ${snippet.type === 'css' ? "b3-chip--primary" : "b3-chip--secondary"}">${escapeHTML(String(snippet.type || "").toUpperCase())}</div>
  <div class="fn__space"></div>
  <div class="fn__flex-1">${escapeHTML(snippetName)}</div>
  <div class="fn__space"></div>
  <input type="checkbox" class="b3-switch fn__flex-center" data-id="${escapeHTML(snippetId)}" />
</div>`;
          }).join("");
          const element = HTMLToElement(`<div class="fn__flex-center" data-type="snippets">${optionsHTML}</div>`);
          const selectedSnippets = new Set(this.data[STORAGE_NAME].snippets);
          element.querySelectorAll<HTMLInputElement>("input[data-id]").forEach((checkbox) => {
            checkbox.checked = selectedSnippets.has(checkbox.getAttribute("data-id") || "");
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
        } else if (
          mutation.type === 'attributes' &&
          mutation.target instanceof HTMLImageElement
        ) {
          const imageElement = mutation.target;
          applyPendingPreviewRefresh(imageElement);
          const imageURL = getExcalidrawImagePath(imageElement);
          if (!imageURL) continue;
          const blockElement = imageElement.closest(
            "div[data-type='NodeParagraph']",
          ) as HTMLElement | null;
          if (!blockElement) continue;
          const hasEditButton = Boolean(blockElement.querySelector(
            '[data-excalidraw-plus-edit], .excalidraw-plus-edit-button',
          ));
          const hasLabel = Boolean(blockElement.querySelector('.label--embed-excalidraw'));
          const dataSrc = imageElement.getAttribute('data-src');
          let isPreviewRefreshMutation = false;
          if (mutation.attributeName === 'data-src' && dataSrc) {
            try {
              const dataSrcURL = resolveLocalURL(dataSrc);
              const refreshToken = previewRefreshTokens.get(dataSrcURL.pathname);
              isPreviewRefreshMutation = Boolean(
                refreshToken &&
                dataSrcURL.searchParams.get('_excalidraw_refresh') === refreshToken,
              );
            } catch (error) {
              isPreviewRefreshMutation = false;
            }
          }
          if (
            (mutation.attributeName === 'data-src' && !isPreviewRefreshMutation) ||
            !hasEditButton ||
            (this.data[STORAGE_NAME].labelDisplay !== 'noLabel' && !hasLabel)
          ) {
            callback(blockElement);
          }
        }
      }
    });

    mutationObserver.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        ...IMAGE_SOURCE_ATTRIBUTES,
        ...IMAGE_SRCSET_ATTRIBUTES,
      ],
    });

    return mutationObserver;
  }

  public async getExcalidrawImageInfo(imageURL: string, reload: boolean): Promise<ExcalidrawImageInfo | null> {
    imageURL = normalizeAssetImagePath(imageURL);
    const imageURLRegex = /^assets\/.+\.(?:svg|png)$/i;
    if (!imageURLRegex.test(imageURL)) return null;

    try {
      const imageContent = await this.getExcalidrawImage(imageURL, reload);
      if (!imageContent) return null;

      const encodedContent = imageContent.split(',').pop();
      if (!encodedContent) return null;
      const isPNG = imageURL.toLowerCase().endsWith(".png");
      const hasMetadata = isPNG
        ? Boolean(locatePNGtEXt(
          base64ToArray(encodedContent),
          "application/vnd.excalidraw+json",
        ))
        : base64ToUnicode(encodedContent).includes("application/vnd.excalidraw+json");
      if (!hasMetadata) return null;

      const imageInfo: ExcalidrawImageInfo = {
        imageURL: imageURL,
        data: imageContent,
        format: isPNG ? "png" : "svg",
      }
      return imageInfo;
    } catch (error) {
      console.warn(`${this.name}: failed to parse Excalidraw image`, error);
      return null;
    }
  }

  public getPlaceholderImageContent(format: 'svg' | 'png'): string {
    let imageContent = defaultImageContent[format];
    return imageContent;
  }

  public async newExcalidrawImage(protyle: Protyle, callback?: (imageInfo: ExcalidrawImageInfo) => void) {
    const format = this.data[STORAGE_NAME].embedImageFormat;
    const imageName = `excalidraw-image-${window.Lute.NewNodeID()}.${format}`;
    const placeholderImageContent = this.getPlaceholderImageContent(format);
    const blob = dataURLToBlob(placeholderImageContent);
    const file = new File([blob], imageName, { type: blob.type });
    const formData = new FormData();
    formData.append('path', `data/assets/${imageName}`);
    formData.append('file', file);
    formData.append('isDir', 'false');
    try {
      await putFile(formData);
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
    } catch (error) {
      console.warn(`${this.name}: failed to create Excalidraw image`, error);
    }
  }

  public async getExcalidrawImage(imageURL: string, reload: boolean): Promise<string> {
    try {
      const requestURL = imageURL.startsWith("/") ? imageURL : `/${imageURL}`;
      const { response, blob } = await fetchBlobWithTimeout(requestURL, {
        cache: reload ? 'reload' : 'default',
      });
      if (!response.ok) return "";
      return await blobToDataURL(blob);
    } catch (error) {
      console.warn(`${this.name}: image request failed`, error);
      return "";
    }
  }

  public updateAttrLabel(imageInfo: ExcalidrawImageInfo, blockElement: HTMLElement) {
    if (!imageInfo) return;

    const attrElement = blockElement.querySelector(".protyle-attr") as HTMLDivElement;
    if (!attrElement) return;

    const labelElement = attrElement.querySelector(
      ".label--embed-excalidraw",
    ) as HTMLDivElement | null;
    if (this.data[STORAGE_NAME].labelDisplay === "noLabel") {
      labelElement?.remove();
      return;
    }

    const nextLabelElement = labelElement || document.createElement("div");
    nextLabelElement.classList.add("label--embed-excalidraw");
    nextLabelElement.classList.toggle(
      "label--embed-excalidraw--always",
      this.data[STORAGE_NAME].labelDisplay === "showLabelAlways",
    );
    nextLabelElement.innerHTML = "<span>Excalidraw</span>";
    if (!labelElement) attrElement.prepend(nextLabelElement);
  }

  private openMenuImageHandler(event: any) {
    const selectedElement = event?.detail?.element as HTMLElement | undefined;
    const imageElement = selectedElement?.matches?.("img")
      ? selectedElement as HTMLImageElement
      : selectedElement?.querySelector("img") as HTMLImageElement | null;
    const imageURL = imageElement ? getExcalidrawImagePath(imageElement) : "";
    if (!imageURL) return;
    const menu = window.siyuan.menus.menu;
    const selectionRoot = imageElement?.closest("[data-node-id]") as HTMLElement | null
      || selectedElement;
    const getCurrentImage = (): HTMLImageElement | null => {
      if (!selectionRoot?.isConnected) return null;
      if (selectionRoot instanceof HTMLImageElement) return selectionRoot;
      return Array.from(
        selectionRoot.querySelectorAll<HTMLImageElement>(
          ".img[data-type='img'] img, img",
        ),
      ).find((image) => Boolean(getExcalidrawImagePath(image))) ?? null;
    };
    this.getExcalidrawImageInfo(imageURL, true).then((imageInfo: ExcalidrawImageInfo) => {
      const currentImageElement = getCurrentImage();
      if (
        imageInfo &&
        menu === window.siyuan.menus.menu &&
        getExcalidrawImagePath(currentImageElement) === imageURL
      ) {
        menu.addItem({
          id: "edit-excalidraw",
          icon: 'iconEdit',
          label: `${this.i18n.editExcalidraw}`,
          index: 1,
          click: () => {
            // Resolve the image again when the menu item is clicked. SiYuan
            // can replace the image node while the asynchronous menu lookup
            // is still in flight.
            const currentImageURL = getExcalidrawImagePath(getCurrentImage());
            if (!currentImageURL) return;
            void this.getExcalidrawImageInfo(currentImageURL, true).then((currentImageInfo) => {
              if (!currentImageInfo) return;
              if (!this.isMobile && this.data[STORAGE_NAME].editWindow === 'tab') {
                this.openEditTab(currentImageInfo);
              } else {
                this.openEditDialog(currentImageInfo);
              }
            }).catch((error) => {
              console.warn(`${this.name}: failed to open image from menu`, error);
            });
          }
        });
      }
    }).catch((error) => {
      console.warn(`${this.name}: failed to prepare image menu`, error);
    });
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
    if (document.activeElement?.closest(".b3-dialog--open .excalidraw-edit-dialog")) {
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
    <iframe src="/plugins/siyuan-embed-excalidraw-plus/app/?lang=${window.siyuan.config.lang.replace('_', '-')}${that.isDarkMode() ? "&dark=1" : ""}&iframeID=${iframeID}&imageURL=${encodeURIComponent(imageInfo.imageURL)}&enableAutoSave=${that.data[STORAGE_NAME].enableAutoSave}&rememberTextStyle=${that.data[STORAGE_NAME].rememberTextStyle}&autoSaveInterval=${that.data[STORAGE_NAME].autoSaveInterval}&fullSaveDelay=${that.data[STORAGE_NAME].fullSaveDelay}"></iframe>
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
        let activeCloseRequestId: string | null = null;
        let iframeKeydownBound = false;
        const clearCloseRequestTimer = () => {
          if (closeRequestTimer) {
            clearTimeout(closeRequestTimer);
            closeRequestTimer = null;
          }
        };
        const resetCloseRequest = () => {
          closeRequested = false;
          closeMessageSent = false;
          activeCloseRequestId = null;
          clearCloseRequestTimer();
        };
        const requestTabClose = () => {
          if (activeCloseRequestId) return;
          const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          activeCloseRequestId = requestId;
          closeRequested = true;
          if (iframeReady && !closeMessageSent) {
            closeMessageSent = true;
            postMessage({ event: 'saveAndExit', requestId });
          }
          closeRequestTimer = setTimeout(() => {
            if (activeCloseRequestId === requestId) {
              resetCloseRequest();
              console.warn('Excalidraw tab close was canceled because saving did not finish');
            }
          }, CLOSE_SAVE_TIMEOUT_MS);
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
        const onInit = () => {
          if (!iframeKeydownBound && iframe.contentWindow) {
            iframe.contentWindow.addEventListener("keydown", keydownEventHandleer);
            iframeKeydownBound = true;
          }
        }

        const onReady = () => {
          iframeReady = true;
          that.injectSnippetsToIframe(iframe);
          if (closeRequested && !closeMessageSent) {
            closeMessageSent = true;
            postMessage({ event: 'saveAndExit', requestId: activeCloseRequestId });
          }
        }

        const onSave = (message: any) => {
          refreshExcalidrawPreview(message);
        }

        const onBrowseLibrary = () => {
          resetCloseRequest();
          closeTabNow();
        };

        const onExit = (message: any) => {
          if (activeCloseRequestId) {
            if (message.requestId !== activeCloseRequestId) return;
          } else if (message.requestId) {
            return;
          }
          resetCloseRequest();
          closeTabNow();
        };

        const onSaveFailed = (message: any) => {
          if (
            !activeCloseRequestId ||
            message.requestId !== activeCloseRequestId
          ) return;
          resetCloseRequest();
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
                  onInit();
                }
                else if (message.event == "ready") {
                  onReady();
                }
                else if (message.event == "save") {
                  onSave(message);
                }
                else if (message.event == "browseLibrary") {
                  onBrowseLibrary();
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
          if (iframeKeydownBound && iframe.contentWindow) {
            iframe.contentWindow.removeEventListener("keydown", keydownEventHandleer);
            iframeKeydownBound = false;
          }
          (this.tab as any).close = closeTabNow;
          resetCloseRequest();
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
            <iframe src="/plugins/siyuan-embed-excalidraw-plus/app/?lang=${window.siyuan.config.lang.replace('_', '-')}&fullscreenBtn=1${this.isDarkMode() ? "&dark=1" : ""}&iframeID=${iframeID}&imageURL=${encodeURIComponent(imageInfo.imageURL)}&enableAutoSave=${this.data[STORAGE_NAME].enableAutoSave}&rememberTextStyle=${this.data[STORAGE_NAME].rememberTextStyle}&autoSaveInterval=${this.data[STORAGE_NAME].autoSaveInterval}&fullSaveDelay=${this.data[STORAGE_NAME].fullSaveDelay}"></iframe>
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
    let activeCloseRequestId: string | null = null;
    const clearCloseRequestTimer = () => {
      if (closeRequestTimer) {
        clearTimeout(closeRequestTimer);
        closeRequestTimer = null;
      }
    };
    const resetCloseRequest = () => {
      closeRequested = false;
      closeMessageSent = false;
      activeCloseRequestId = null;
      clearCloseRequestTimer();
    };
    const requestDialogClose = () => {
      if (activeCloseRequestId) return;
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      activeCloseRequestId = requestId;
      closeRequested = true;
      if (iframeReady && !closeMessageSent) {
        closeMessageSent = true;
        postMessage({ event: 'saveAndExit', requestId });
      }
      closeRequestTimer = setTimeout(() => {
        if (activeCloseRequestId === requestId) {
          resetCloseRequest();
          console.warn('Excalidraw close was canceled because saving did not finish');
        }
      }, CLOSE_SAVE_TIMEOUT_MS);
    };
    (dialog as any).destroy = requestDialogClose;

    const onInit = () => {}

    const onReady = () => {
      iframeReady = true;
      this.injectSnippetsToIframe(iframe);
      if (closeRequested && !closeMessageSent) {
        closeMessageSent = true;
        postMessage({ event: 'saveAndExit', requestId: activeCloseRequestId });
      }
    }

    const onSave = (message: any) => {
      refreshExcalidrawPreview(message);
    }

    const onBrowseLibrary = () => {
      resetCloseRequest();
      destroyDialogNow();
    };

    const onExit = (message: any) => {
      if (activeCloseRequestId) {
        if (message.requestId !== activeCloseRequestId) return;
      } else if (message.requestId) {
        return;
      }
      resetCloseRequest();
      destroyDialogNow();
    };

    const onSaveFailed = (message: any) => {
      if (
        !activeCloseRequestId ||
        message.requestId !== activeCloseRequestId
      ) return;
      resetCloseRequest();
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
              onInit();
            }
            else if (message.event == "ready") {
              onReady();
            }
            else if (message.event == "save") {
              onSave(message);
            }
            else if (message.event == "browseLibrary") {
              onBrowseLibrary();
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
      resetCloseRequest();
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

  private async getSnippets(snippetIDs?: string[]): Promise<ISnippet[] | null> {
    try {
      const response = await fetchSyncPost("/api/snippet/getSnippet", { type: "all", enabled: 2 });
      if (!response || response.code !== 0) {
        console.warn(`${this.name}: get snippets failed`);
        return null;
      }
      let snippets = ((response.data?.snippets || []) as ISnippet[]).filter(
        (snippet) => snippet && typeof snippet.id === "string",
      );
      // 当指定snippetIDs时，只返回指定的snippets
      if (typeof snippetIDs !== 'undefined') {
        const selectedSnippetIDs = new Set(snippetIDs);
        snippets = snippets.filter(snippet => selectedSnippetIDs.has(snippet.id));
      }
      return snippets;
    } catch (error) {
      console.warn(`${this.name}: get snippets failed`, error);
      return null;
    }
  }

  private async injectSnippetsToIframe(iframe: HTMLIFrameElement) {
    if (!iframe.isConnected || this._snippetInjectionInFlight.has(iframe)) return;
    const head = iframe.contentDocument?.head;
    const hasLoadedSnippets = (target: HTMLHeadElement): boolean => (
      target.dataset.excalidrawPlusSnippetsLoaded === 'true' ||
      Boolean(target.querySelector('[data-excalidraw-plus-snippet="true"]'))
    );
    if (!head || hasLoadedSnippets(head)) return;

    this._snippetInjectionInFlight.add(iframe);
    try {
      const snippets = await this.getSnippets(this.data[STORAGE_NAME].snippets);
      if (!snippets) return;
      if (!iframe.isConnected) return;
      const currentHead = iframe.contentDocument?.head;
      if (!currentHead || hasLoadedSnippets(currentHead)) return;
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
        snippetElement.setAttribute('data-excalidraw-plus-snippet', 'true');
        currentHead.appendChild(snippetElement);
      });
      currentHead.dataset.excalidrawPlusSnippetsLoaded = 'true';
    } finally {
      this._snippetInjectionInFlight.delete(iframe);
    }
  }

  private removeTempDir() {
    fetchPost("/api/file/removeFile", {path: `/temp/${PLUGIN_ID}`});
  }
}
