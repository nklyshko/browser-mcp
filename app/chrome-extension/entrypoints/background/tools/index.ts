import { createErrorResponse, type ToolProgressReporter } from '@/common/tool-handler';
import { getMessage } from '@/utils/i18n';
import { ERROR_MESSAGES } from '@/common/constants';
import type { ToolResult } from '@/common/tool-handler';
import { resolveActionPolicy, runWithActionPolicy } from './action-policy';
import * as browserTools from './browser';
import { pauseSpaFetchTabCleanup, scheduleSpaFetchTabCleanup } from './browser/spa-fetch';
import { createToolRegistry } from './tool-registry';

const browserToolNames = [
  'navigateTool',
  'closeTabsTool',
  'switchTabTool',
  'createTabTool',
  'hoverTool',
  'printToPdfTool',
  'elementInfoTool',
  'storageGetTool',
  'storageSetTool',
  'storageDeleteTool',
  'windowTool',
  'cookieGetTool',
  'cookieSetTool',
  'cookieDeleteTool',
  'searchTabsContentTool',
  'screenshotTool',
  'webFetcherTool',
  'getInteractiveElementsTool',
  'clickTool',
  'fillTool',
  'elementLocatorTool',
  'elementPickerTool',
  'selectAllItemsTool',
  'networkRequestTool',
  'networkCaptureTool',
  'blockImagesTool',
  'blockResourcesTool',
  'keyboardTool',
  'historyTool',
  'bookmarkSearchTool',
  'bookmarkAddTool',
  'bookmarkDeleteTool',
  'javascriptTool',
  'pasteTextTool',
  'consoleTool',
  'fileUploadTool',
  'pasteImageTool',
  'formValueTool',
  'readPageTool',
  'actionSnapshotTool',
  'computerTool',
  'postToXTool',
  'handleDialogTool',
  'handleDownloadTool',
  'userscriptTool',
  'performanceStartTraceTool',
  'performanceStopTraceTool',
  'performanceAnalyzeInsightTool',
  'gifRecorderTool',
  'getTabUrlTool',
  'scrollStateTool',
  'scrollTool',
  'waitTool',
  'extractTool',
  'pageTextTool',
  'spaFetchTool',
  'clickAndWaitTool',
  'taskContextTool',
  'scopedActionTool',
  'diagnosticSnapshotTool',
  'errorLogsTool',
  'proxyDiagnosticsTool',
  'proxyRotateTool',
  'listFramesTool',
  'captureDebugBundleTool',
  'collectVirtualListTool',
  'collectVirtualListsTool',
  'crawlLinksTool',
  'extractThreadTool',
  'resumeTabTaskTool',
  'waitExtractResponseTool',
  'detectEmptyStateTool',
  'extractReviewSummaryTool',
  'expandSectionTool',
  'extractRecordsTool',
  'findAndClickTool',
  'mergeRecordsTool',
  'paginateExtractTool',
  'scanForSectionTool',
] as const satisfies readonly (keyof typeof browserTools)[];

export const browserToolExports = browserToolNames.flatMap((name) =>
  name in browserTools ? [browserTools[name]] : [],
);

const toolsMap = createToolRegistry(browserToolExports);

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: Record<string, unknown>;
}

function compact(value: unknown, max = 72): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isCoordinates(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object') return false;
  const coordinates = value as { x?: unknown; y?: unknown };
  return (
    typeof coordinates.x === 'number' &&
    Number.isFinite(coordinates.x) &&
    typeof coordinates.y === 'number' &&
    Number.isFinite(coordinates.y)
  );
}

/** getMessage, but null when the key has no text so callers can fall back. */
function optionalMessage(key: string, substitutions?: string[]): string | null {
  const text = getMessage(key, substitutions);
  return text && text !== key ? text : null;
}

function duration(value: unknown, fallbackMs: number): string {
  const ms = typeof value === 'number' && value >= 0 ? value : fallbackMs;
  return getMessage('opSeconds', [String(ms / 1000)]);
}

function target(args: Record<string, unknown>): string {
  const selector = compact(args.selector);
  if (selector) return selector;
  const ref = compact(args.ref);
  if (ref) return getMessage('opElementRef', [ref]);
  const coordinates = args.coordinates as { x?: unknown; y?: unknown } | undefined;
  if (typeof coordinates?.x === 'number' && typeof coordinates.y === 'number')
    return getMessage('opCoordinates', [String(coordinates.x), String(coordinates.y)]);
  return getMessage('opCurrentTarget');
}

/**
 * The "wait for ..." clause of chrome_click_and_wait.
 *
 * Kept separate from the rest of the detail because the in-page overlay swaps
 * the click half for a friendlier element name and has to keep this half
 * intact. It used to slice the formatted string on a full-width semicolon,
 * which broke on any detail that happened to contain one.
 */
function clickWaitTail(args: Record<string, unknown>): string {
  return getMessage('opWaitTail', [
    compact(args.waitSelector) || getMessage('opTargetElement'),
    String(args.waitFor || 'visible'),
    duration(args.waitTimeout, 10_000),
  ]);
}

function operationDetail(param: ToolCallParam): string {
  const args = (param.args || {}) as Record<string, unknown>;
  switch (param.name) {
    case 'get_windows_and_tabs':
      return getMessage('opGetWindowsAndTabs');
    case 'chrome_create_tab':
      return compact(args.url)
        ? getMessage('opCreateTabUrl', [compact(args.url)])
        : getMessage('opCreateTab');
    case 'chrome_hover':
      return getMessage('opHover', [target(args)]);
    case 'chrome_get_element_info':
      return getMessage('opGetElementInfo', [target(args)]);
    case 'chrome_print_to_pdf':
      return getMessage('opPrintToPdf');
    case 'chrome_storage_get':
      return getMessage('opStorageGet');
    case 'chrome_storage_set':
      return getMessage('opStorageSet');
    case 'chrome_storage_delete':
      return getMessage('opStorageDelete');
    case 'search_tabs_content':
      return getMessage('opSearch', [
        compact(args.query || args.text) || getMessage('opTabContents'),
      ]);
    case 'chrome_screenshot':
      return args.fullPage
        ? getMessage('opScreenshotFullPage')
        : getMessage('opScreenshotTarget', [target(args)]);
    case 'chrome_close_tabs':
      return getMessage('opCloseTabs', [
        String(Array.isArray(args.tabIds) ? args.tabIds.length : 1),
      ]);
    case 'chrome_switch_tab':
      return getMessage('opSwitchTab', [String(args.tabId || getMessage('opCurrentTab'))]);
    case 'chrome_get_web_content':
      return getMessage('opGetWebContent', [
        args.htmlContent ? 'HTML' : getMessage('opKindText'),
        compact(args.url) || target(args),
      ]);
    case 'chrome_get_interactive_elements':
      return compact(args.textQuery)
        ? getMessage('opInteractiveElementsQuery', [compact(args.textQuery)])
        : getMessage('opInteractiveElements');
    case 'chrome_request_element_selection': {
      const names = Array.isArray(args.requests)
        ? args.requests
            .map((request: { name?: unknown }) => compact(request?.name, 30))
            .filter(Boolean)
        : [];
      const listed = names.slice(0, 3).join(', ') || getMessage('opPageElements');
      return getMessage('opRequestSelection', [
        names.length > 3 ? getMessage('opAndMore', [listed]) : listed,
        duration(args.timeoutMs, 180_000),
      ]);
    }
    case 'chrome_click_element':
      return getMessage('opTargetPrefix', [target(args)]);
    case 'chrome_click_and_wait':
      return `${getMessage('opClick', [target(args)])}${clickWaitTail(args)}`;
    case 'chrome_wait':
      return getMessage('opWait', [
        compact(args.jsCondition) || target(args),
        String(args.waitFor || 'visible'),
        duration(args.timeout, 10_000),
      ]);
    case 'chrome_fill_or_select':
      return getMessage('opTargetPrefix', [target(args)]);
    case 'chrome_keyboard':
      return getMessage('opKeyboard', [target(args)]);
    case 'chrome_upload_file':
      return getMessage('opUploadFile', [target(args)]);
    case 'chrome_read_page':
      return args.filter === 'interactive'
        ? getMessage('opReadPageInteractive')
        : getMessage('opReadPageVisible');
    case 'chrome_get_page_text':
      return getMessage('opGetPageText', [target(args)]);
    case 'chrome_spa_fetch':
      return getMessage('opSpaFetch', [
        compact(args.url) || target(args),
        String(args.maxScrolls || 5),
      ]);
    case 'chrome_extract':
      return getMessage('opExtract', [target(args)]);
    case 'chrome_scroll': {
      const container = compact(args.containerSelector);
      if (args.toBottom)
        return container
          ? getMessage('opScrollBottomIn', [container])
          : getMessage('opScrollBottom');
      if (args.toTop)
        return container ? getMessage('opScrollTopIn', [container]) : getMessage('opScrollTop');
      if (args.scrollIntoView) return getMessage('opScrollTo', [target(args)]);
      const direction = String(args.direction || getMessage('opDirectionDown'));
      const amount = String(args.amount || 300);
      return container
        ? getMessage('opScrollByIn', [direction, amount, container])
        : getMessage('opScrollBy', [direction, amount]);
    }
    case 'chrome_navigate':
      return getMessage('opNavigate', [compact(args.url) || getMessage('opTargetPage')]);
    case 'chrome_network_capture':
      return args.action === 'start'
        ? getMessage('opNetworkCaptureStart')
        : getMessage('opNetworkCaptureStop');
    case 'chrome_block_images':
      return args.action === 'start' ? getMessage('opBlockImages') : getMessage('opUnblockImages');
    case 'chrome_network_capture_start':
    case 'chrome_network_debugger_start':
      return getMessage('opNetworkCaptureStart');
    case 'chrome_network_capture_stop':
    case 'chrome_network_debugger_stop':
      return getMessage('opNetworkCaptureStop');
    case 'chrome_network_request':
      return getMessage('opNetworkRequest', [String(args.method || 'GET')]);
    case 'chrome_history':
      return compact(args.text)
        ? getMessage('opHistoryQuery', [compact(args.text)])
        : getMessage('opHistory');
    case 'chrome_bookmark_search':
      return compact(args.query)
        ? getMessage('opBookmarkSearchQuery', [compact(args.query)])
        : getMessage('opBookmarkSearch');
    case 'chrome_bookmark_add':
      return getMessage('opBookmarkAdd');
    case 'chrome_bookmark_delete':
      return getMessage('opBookmarkDelete');
    case 'chrome_handle_dialog':
      return args.action === 'accept'
        ? getMessage('opDialogAccept')
        : getMessage('opDialogDismiss');
    case 'chrome_handle_download':
      return compact(args.action)
        ? getMessage('opHandleDownloadAction', [compact(args.action)])
        : getMessage('opHandleDownload');
    case 'chrome_computer':
      return getMessage('opComputer', [
        compact(args.action) || getMessage('opComputerMouse'),
        target(args),
      ]);
    case 'chrome_post_to_x':
      return getMessage('opPostToX', [compact(args.text, 60) || getMessage('opPostBody')]);
    case 'chrome_javascript':
      return getMessage('opJavascript');
    case 'chrome_paste_text':
      return getMessage('opPasteText', [target(args)]);
    case 'chrome_console':
      return getMessage('opConsole');
    case 'chrome_userscript':
      return getMessage('opUserscript', [compact(args.action) || getMessage('opActionFallback')]);
    case 'performance_start_trace':
      return args.reload ? getMessage('opTraceStartReload') : getMessage('opTraceStart');
    case 'performance_stop_trace':
      return getMessage('opTraceStop');
    case 'performance_analyze_insight':
      return getMessage('opTraceAnalyze');
    case 'chrome_gif_recorder': {
      const action = compact(args.action) || getMessage('opGifStart');
      return args.durationMs
        ? getMessage('opGifRecorderDuration', [action, duration(args.durationMs, 0)])
        : getMessage('opGifRecorder', [action]);
    }
    case 'chrome_get_tab_url':
      return getMessage('opGetTabUrl');
    case 'chrome_proxy_rotate':
      return compact(args.reason)
        ? getMessage('opProxyRotateReason', [compact(args.reason)])
        : getMessage('opProxyRotate');
    case 'chrome_get_scroll_state':
      return getMessage('opGetScrollState');
    case 'chrome_extract_review_summary':
      return getMessage('opExtractReviewSummary');
    default:
      return '';
  }
}

/** Overlay lifecycle state. Resolved to display text before injection. */
type OperationState = 'running' | 'done' | 'failed';

const STATE_KEYS: Record<OperationState, string> = {
  running: 'opStateRunning',
  done: 'opStateDone',
  failed: 'opStateFailed',
};

async function showOperation(param: ToolCallParam, state: OperationState) {
  const tabId = param.args?.tabId;
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab =
      typeof tabId === 'number'
        ? await chrome.tabs.get(tabId)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  } catch {
    return;
  }
  if (!tab?.id) return;

  // The overlay is best-effort; only pass primitives so malformed tool input cannot block the tool.
  const selector =
    compact(param.args?.selector) ||
    (param.name === 'chrome_scroll' ? compact(param.args?.containerSelector) : '') ||
    null;
  const coordinates = param.args?.coordinates;
  const safeCoordinates = isCoordinates(coordinates) ? coordinates : null;
  const intent = compact(param.args?.intent, 160) || null;

  // Display text is resolved here rather than in the page: the overlay only
  // needs the handful of strings below, and chrome.i18n in the background reads
  // the same _locales. `labels` is built from our own catalogue, not from tool
  // input, so it does not weaken the primitives-only rule above.
  const labels = {
    state: getMessage(STATE_KEYS[state]),
    action: optionalMessage(`opAction_${param.name}`) || String(param.name).replace(/^chrome_/, ''),
    intent: getMessage('opIntentPrefix'),
    click: getMessage('opVerbClick'),
    expand: getMessage('opVerbExpand'),
    collapse: getMessage('opVerbCollapse'),
    // Only set when the tool is scrolling an element into view, so the page no
    // longer has to sniff the detail string for a "scroll to" prefix.
    scrollTo:
      param.name === 'chrome_scroll' && param.args?.scrollIntoView
        ? getMessage('opScrollToLabel')
        : null,
    target: optionalMessage(`opTargetLabel_${param.name}`),
  };
  const waitTail =
    param.name === 'chrome_click_and_wait'
      ? clickWaitTail((param.args || {}) as Record<string, unknown>)
      : null;

  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        ...(typeof param.args?.frameId === 'number' ? { frameIds: [param.args.frameId] } : {}),
      },
      args: [
        param.name,
        selector,
        compact(param.args?.ref) || null,
        safeCoordinates,
        labels,
        operationDetail(param),
        intent,
        waitTail,
        state === 'running',
      ],
      func: (
        name: string,
        selector: string | null,
        ref: string | null,
        coordinates: { x: number; y: number } | null,
        labels: {
          state: string;
          action: string;
          intent: string;
          click: string;
          expand: string;
          collapse: string;
          scrollTo: string | null;
          target: string | null;
        },
        detail: string,
        intent: string | null,
        waitTail: string | null,
        isRunning: boolean,
      ) => {
        const statusId = '__mcp_operation_status__';
        const highlightId = '__mcp_operation_highlight__';
        const root = document.documentElement || document.body;
        let status = document.getElementById(statusId);
        if (!status) {
          status = document.createElement('div');
          status.id = statusId;
          Object.assign(status.style, {
            position: 'fixed',
            left: '16px',
            bottom: '16px',
            zIndex: '2147483647',
            padding: '8px 12px',
            borderRadius: '8px',
            background: 'rgba(17, 24, 39, .9)',
            color: '#fff',
            font: '13px/1.4 system-ui, sans-serif',
            whiteSpace: 'pre-line',
            maxWidth: '360px',
            pointerEvents: 'none',
            boxShadow: '0 4px 14px rgba(0,0,0,.25)',
          });
          root.append(status);
        }
        let target: Element | null = null;
        try {
          target = selector ? document.querySelector(String(selector)) : null;
        } catch {}
        if (!target && ref) {
          const map = (window as any).__claudeElementMap;
          const value = map instanceof Map ? map.get(ref) : map?.[ref];
          target =
            value instanceof Element
              ? value
              : value?.element instanceof Element
                ? value.element
                : null;
        }
        const elementName = target
          ? [
              target.getAttribute('aria-label'),
              target.getAttribute('title'),
              target.textContent?.trim().replace(/\s+/g, ' '),
            ]
              .find((value) => value)
              ?.slice(0, 72)
          : '';
        // Prefer the element's own accessible name over the raw selector.
        if (elementName && (name === 'chrome_click_element' || name === 'chrome_click_and_wait')) {
          const expanded = target?.getAttribute('aria-expanded');
          const verb =
            expanded === 'false'
              ? labels.expand
              : expanded === 'true'
                ? labels.collapse
                : labels.click;
          detail = `${verb}: ${elementName}${waitTail || ''}`;
        } else if (elementName && labels.scrollTo) {
          detail = `${labels.scrollTo}: ${elementName}`;
        } else if (elementName && labels.target) {
          detail = `${labels.target}: ${elementName}`;
        }
        status.textContent = `${labels.state}: ${labels.action}${detail ? `\n${detail}` : ''}${
          intent ? `\n${labels.intent}: ${intent}` : ''
        }`;

        const rect = target?.getBoundingClientRect();
        const x = rect?.left ?? Number((coordinates as any)?.x);
        const y = rect?.top ?? Number((coordinates as any)?.y);
        const width = rect?.width ?? ((coordinates as any) ? 28 : 0);
        const height = rect?.height ?? ((coordinates as any) ? 28 : 0);
        let highlight = document.getElementById(highlightId);
        if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
          if (!highlight) {
            highlight = document.createElement('div');
            highlight.id = highlightId;
            Object.assign(highlight.style, {
              position: 'fixed',
              zIndex: '2147483646',
              pointerEvents: 'none',
              border: '3px solid #f97316',
              borderRadius: '5px',
              background: 'rgba(249,115,22,.12)',
              boxShadow: '0 0 0 2px rgba(255,255,255,.9)',
            });
            root.append(highlight);
          }
          Object.assign(highlight.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`,
            display: 'block',
          });
        }
        const key = '__mcpOperationOverlayTimer__';
        clearTimeout((window as any)[key]);
        (window as any)[key] = setTimeout(
          () => {
            status?.remove();
            highlight?.remove();
          },
          isRunning ? 120_000 : 1_800,
        );
      },
    });
  } catch {
    // Status rendering must never turn a successful tool call into a failure.
  }
}

async function checkExpectedUrl(param: ToolCallParam): Promise<string | null> {
  const expectedUrl = String(param.args?.expectedUrl || '');
  if (!expectedUrl) return null;
  const tabId = param.args?.tabId;
  const tab =
    typeof tabId === 'number'
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.url?.startsWith(expectedUrl))
    return `Expected URL prefix ${expectedUrl}, got ${tab?.url || 'none'}`;
  return null;
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (
  param: ToolCallParam,
  signal?: AbortSignal,
  reportProgress?: ToolProgressReporter,
) => {
  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  let pausedTemporaryTabId: number | null = null;
  const isBackgroundOnlyTool = param.name === 'chrome_error_logs';
  try {
    if (signal?.aborted) return createErrorResponse('Tool call cancelled');
    const urlError = await checkExpectedUrl(param);
    if (urlError) return createErrorResponse(urlError);
    const args = { ...(param.args || {}) };
    if (args.background === undefined && param.name !== 'chrome_spa_fetch') {
      const { backgroundOperations = true } =
        await chrome.storage.local.get('backgroundOperations');
      args.background = backgroundOperations;
    }
    if (!(param.name === 'chrome_spa_fetch' && args.url && args.tabId === undefined)) {
      const targetTabId =
        typeof args.tabId === 'number'
          ? args.tabId
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (typeof targetTabId === 'number' && (await pauseSpaFetchTabCleanup(targetTabId))) {
        pausedTemporaryTabId = targetTabId;
      }
    }
    if (!isBackgroundOnlyTool) await showOperation(param, 'running');
    const actionPolicy = resolveActionPolicy(param.name, args);
    const result = await runWithActionPolicy<ToolResult>(actionPolicy, signal, () =>
      reportProgress ? tool.execute(args, signal, reportProgress) : tool.execute(args, signal),
    );
    if (!isBackgroundOnlyTool) void showOperation(param, result.isError ? 'failed' : 'done');
    return result;
  } catch (error) {
    if (!isBackgroundOnlyTool) void showOperation(param, 'failed');
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  } finally {
    if (pausedTemporaryTabId !== null) {
      await scheduleSpaFetchTabCleanup(pausedTemporaryTabId).catch(() => undefined);
    }
  }
};
