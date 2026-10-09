// node-specs-builtin.ts — builtin NodeSpecs shared for UI + runtime
//
// Every user-facing string here is an i18n key, not a literal: this package is
// also loaded by the native server, which has no chrome.i18n. The builder UI is
// the only consumer, so it passes chrome.i18n's getMessage in as `t` and the
// package itself stays free of any browser dependency.
import type { NodeSpec } from './node-spec';
import { registerNodeSpec } from './node-spec-registry';
import { STEP_TYPES } from './step-types';

/** Resolves a message key. The builder passes chrome.i18n's getMessage. */
export type SpecTranslator = (key: string) => string;

export function registerBuiltinSpecs(t: SpecTranslator) {
  const nav: NodeSpec = {
    type: STEP_TYPES.NAVIGATE,
    version: 1,
    display: { label: t('specNodeNavigate'), iconClass: 'icon-navigate', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'url',
        label: 'URL',
        type: 'string',
        required: true,
        placeholder: 'https://example.com',
        help: t('specFieldUrlHelp'),
        default: '',
      },
    ],
    defaults: { url: '' },
    validate: (cfg) => {
      const errs: string[] = [];
      if (!cfg || !cfg.url || String(cfg.url).trim() === '') errs.push(t('specUrlRequired'));
      return errs;
    },
  };
  registerNodeSpec(nav);

  // Click / Dblclick
  registerNodeSpec({
    type: STEP_TYPES.CLICK,
    version: 1,
    display: { label: t('specNodeClick'), iconClass: 'icon-click', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'target',
        label: t('specFieldTarget'),
        type: 'json',
        widget: 'targetlocator',
        help: t('specFieldTargetHelp'),
      },
      {
        key: 'before',
        label: t('specFieldBefore'),
        type: 'object',
        fields: [
          {
            key: 'scrollIntoView',
            label: t('specFieldScrollIntoView'),
            type: 'boolean',
            default: true,
          },
          {
            key: 'waitForSelector',
            label: t('specFieldWaitForSelector'),
            type: 'boolean',
            default: true,
          },
        ],
      },
      {
        key: 'after',
        label: t('specFieldAfter'),
        type: 'object',
        fields: [
          {
            key: 'waitForNavigation',
            label: t('specFieldWaitForNavigation'),
            type: 'boolean',
            default: false,
          },
          {
            key: 'waitForNetworkIdle',
            label: t('specFieldWaitForNetworkIdle'),
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
    defaults: {
      before: { scrollIntoView: true, waitForSelector: true },
      after: { waitForNavigation: false, waitForNetworkIdle: false },
    },
  });
  registerNodeSpec({
    type: STEP_TYPES.DBLCLICK,
    version: 1,
    display: { label: t('specNodeDblclick'), iconClass: 'icon-click', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: t('specFieldTarget'), type: 'json', widget: 'targetlocator' },
      {
        key: 'before',
        label: t('specFieldBefore'),
        type: 'object',
        fields: [
          {
            key: 'scrollIntoView',
            label: t('specFieldScrollIntoView'),
            type: 'boolean',
            default: true,
          },
          {
            key: 'waitForSelector',
            label: t('specFieldWaitForSelector'),
            type: 'boolean',
            default: true,
          },
        ],
      },
      {
        key: 'after',
        label: t('specFieldAfter'),
        type: 'object',
        fields: [
          {
            key: 'waitForNavigation',
            label: t('specFieldWaitForNavigation'),
            type: 'boolean',
            default: false,
          },
          {
            key: 'waitForNetworkIdle',
            label: t('specFieldWaitForNetworkIdle'),
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
    defaults: {
      before: { scrollIntoView: true, waitForSelector: true },
      after: { waitForNavigation: false, waitForNetworkIdle: false },
    },
  });

  // Fill
  registerNodeSpec({
    type: STEP_TYPES.FILL,
    version: 1,
    display: { label: t('specNodeFill'), iconClass: 'icon-fill', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: t('specFieldTarget'), type: 'json', widget: 'targetlocator' },
      {
        key: 'value',
        label: t('specFieldValue'),
        type: 'string',
        required: true,
        help: t('specFieldValueHelp'),
      },
    ],
    defaults: { value: '' },
  });

  // Key
  registerNodeSpec({
    type: STEP_TYPES.KEY,
    version: 1,
    display: { label: t('specNodeKey'), iconClass: 'icon-key', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'keys',
        label: t('specFieldKeys'),
        type: 'string',
        widget: 'keysequence',
        required: true,
        help: t('specFieldKeysHelp'),
      },
      {
        key: 'target',
        label: t('specFieldFocusTargetOptional'),
        type: 'json',
        widget: 'targetlocator',
      },
    ],
    defaults: { keys: '' },
  });

  // Scroll
  registerNodeSpec({
    type: STEP_TYPES.SCROLL,
    version: 1,
    display: { label: t('specNodeScroll'), iconClass: 'icon-scroll', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'mode',
        label: t('specFieldMode'),
        type: 'select',
        options: [
          { label: t('specModeElement'), value: 'element' },
          { label: t('specModeOffset'), value: 'offset' },
          { label: t('specModeContainer'), value: 'container' },
        ] as any,
        default: 'offset',
      },
      {
        key: 'target',
        label: t('specFieldTargetElementOrContainer'),
        type: 'json',
        widget: 'targetlocator',
      },
      {
        key: 'offset',
        label: t('specFieldOffset'),
        type: 'object',
        fields: [
          { key: 'x', label: 'X', type: 'number' },
          { key: 'y', label: 'Y', type: 'number' },
        ],
      },
    ],
    defaults: { mode: 'offset', offset: { x: 0, y: 300 } },
  });

  // Drag
  registerNodeSpec({
    type: STEP_TYPES.DRAG,
    version: 1,
    display: { label: t('specNodeDrag'), iconClass: 'icon-drag', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'start', label: t('specFieldStart'), type: 'json', widget: 'targetlocator' },
      { key: 'end', label: t('specFieldEnd'), type: 'json', widget: 'targetlocator' },
      {
        key: 'path',
        label: t('specFieldPath'),
        type: 'array',
        item: {
          key: 'p',
          label: t('specFieldPoint'),
          type: 'object',
          fields: [
            { key: 'x', label: 'X', type: 'number' },
            { key: 'y', label: 'Y', type: 'number' },
          ],
        } as any,
      },
    ],
    defaults: {},
  });

  // Wait
  registerNodeSpec({
    type: STEP_TYPES.WAIT,
    version: 1,
    display: { label: t('specNodeWait'), iconClass: 'icon-wait', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'condition',
        label: t('specFieldConditionJson'),
        type: 'json',
        help: t('specFieldWaitConditionHelp'),
      },
    ],
    defaults: { condition: { sleep: 500 } },
  });

  // Assert
  registerNodeSpec({
    type: STEP_TYPES.ASSERT,
    version: 1,
    display: { label: t('specNodeAssert'), iconClass: 'icon-assert', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }, { label: 'onError' }] },
    schema: [
      {
        key: 'assert',
        label: t('specFieldAssertJson'),
        type: 'json',
        help: t('specFieldAssertHelp'),
      },
      {
        key: 'failStrategy',
        label: t('specFieldFailStrategy'),
        type: 'select',
        options: [
          { label: t('specFailStop'), value: 'stop' },
          { label: t('specFailWarn'), value: 'warn' },
          { label: t('specFailRetry'), value: 'retry' },
        ] as any,
        default: 'stop',
      },
    ],
    defaults: { assert: {} },
  });

  // HTTP
  registerNodeSpec({
    type: STEP_TYPES.HTTP,
    version: 1,
    display: { label: 'HTTP', iconClass: 'icon-http', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'method',
        label: t('specFieldMethod'),
        type: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({
          label: m === 'GET' ? t('specMethodGetRecommended') : m,
          value: m,
        })) as any,
        default: 'GET',
      },
      { key: 'url', label: 'URL', type: 'string', required: true },
      { key: 'headers', label: t('specFieldHeadersJson'), type: 'json' },
      { key: 'body', label: t('specFieldBodyJson'), type: 'json' },
      { key: 'formData', label: t('specFieldFormDataJson'), type: 'json' },
      { key: 'saveAs', label: t('specFieldSaveAsVar'), type: 'string' },
      { key: 'assign', label: t('specFieldAssignJson'), type: 'json' },
    ],
    defaults: { method: 'GET', headers: {}, saveAs: 'response' },
  });

  // Extract
  registerNodeSpec({
    type: STEP_TYPES.EXTRACT,
    version: 1,
    display: { label: t('specNodeExtract'), iconClass: 'icon-extract', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'mode',
        label: t('specFieldExtractMode'),
        type: 'select',
        options: [
          { label: t('specExtractSelectorRecommended'), value: 'selector' },
          { label: t('specExtractCustomJs'), value: 'js' },
        ] as any,
        default: 'selector',
      },
      { key: 'selector', label: t('specFieldSelector'), type: 'string', widget: 'selector' },
      {
        key: 'attr',
        label: t('specFieldAttr'),
        type: 'select',
        options: [
          { label: t('specAttrTextRecommended'), value: 'text' },
          { label: t('specAttrTextContent'), value: 'textContent' },
          { label: t('specAttrCustomName'), value: 'attr' },
        ] as any,
      },
      {
        key: 'js',
        label: t('specFieldCustomJs'),
        type: 'string',
        help: t('specFieldCustomJsHelp'),
      },
      { key: 'saveAs', label: t('specFieldSaveVar'), type: 'string', required: true },
    ],
    defaults: { mode: 'selector', attr: 'text', saveAs: 'result' },
  });

  // Screenshot
  registerNodeSpec({
    type: STEP_TYPES.SCREENSHOT,
    version: 1,
    display: { label: t('specNodeScreenshot'), iconClass: 'icon-screenshot', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: t('specFieldTargetSelector'), type: 'string' },
      { key: 'fullPage', label: t('specFieldFullPage'), type: 'boolean', default: false },
      { key: 'saveAs', label: t('specFieldSaveVar'), type: 'string' },
    ],
    defaults: { fullPage: false, saveAs: 'screenshot' },
  });

  registerNodeSpec({
    type: STEP_TYPES.GET_TAB_URL,
    version: 1,
    display: { label: t('specNodeGetTabUrl'), iconClass: 'icon-http', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'tabId', label: t('specFieldTabIdCurrent'), type: 'number', default: 0 },
      { key: 'saveAs', label: t('specFieldSaveVar'), type: 'string', required: true },
    ],
    defaults: { tabId: 0, saveAs: 'tabInfo' },
    validate: (cfg) => (!String(cfg?.saveAs || '').trim() ? [t('specSaveVarRequired')] : []),
  });

  registerNodeSpec({
    type: STEP_TYPES.READ_PAGE,
    version: 1,
    display: { label: t('specNodeReadPage'), iconClass: 'icon-extract', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'filter',
        label: t('specFieldFilter'),
        type: 'select',
        options: [{ label: t('specFilterInteractive'), value: 'interactive' }] as any,
        default: 'interactive',
      },
      { key: 'depth', label: t('specFieldDepthMax'), type: 'number', min: 0 },
      { key: 'saveAs', label: t('specFieldSaveVar'), type: 'string', required: true },
    ],
    defaults: { filter: 'interactive', saveAs: 'page' },
    validate: (cfg) => (!String(cfg?.saveAs || '').trim() ? [t('specSaveVarRequired')] : []),
  });

  registerNodeSpec({
    type: STEP_TYPES.GET_WEB_CONTENT,
    version: 1,
    display: { label: t('specNodeGetWebContent'), iconClass: 'icon-script', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'htmlContent', label: t('specFieldGetHtml'), type: 'boolean', default: false },
      { key: 'textContent', label: t('specFieldGetText'), type: 'boolean', default: true },
      {
        key: 'selector',
        label: t('specFieldScopeSelectorOptional'),
        type: 'string',
        widget: 'selector',
      },
      { key: 'saveAs', label: t('specFieldSaveVar'), type: 'string', required: true },
    ],
    defaults: { htmlContent: false, textContent: true, selector: '', saveAs: 'content' },
    validate: (cfg) => (!String(cfg?.saveAs || '').trim() ? [t('specSaveVarRequired')] : []),
  });

  // TriggerEvent
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER_EVENT,
    version: 1,
    display: { label: t('specNodeTriggerEvent'), iconClass: 'icon-trigger', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: t('specFieldTarget'), type: 'json', widget: 'targetlocator' },
      { key: 'event', label: t('specFieldEventType'), type: 'string', required: true },
      { key: 'bubbles', label: t('specFieldBubbles'), type: 'boolean', default: true },
      { key: 'cancelable', label: t('specFieldCancelable'), type: 'boolean', default: false },
    ],
    defaults: { event: 'click', bubbles: true, cancelable: false },
  });

  // SetAttribute
  registerNodeSpec({
    type: STEP_TYPES.SET_ATTRIBUTE,
    version: 1,
    display: { label: t('specNodeSetAttribute'), iconClass: 'icon-attr', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: t('specFieldTarget'), type: 'json', widget: 'targetlocator' },
      { key: 'name', label: t('specFieldAttrName'), type: 'string', required: true },
      { key: 'value', label: t('specFieldAttrValue'), type: 'string' },
      { key: 'remove', label: t('specFieldRemoveAttr'), type: 'boolean', default: false },
    ],
    defaults: { remove: false },
  });

  // LoopElements
  registerNodeSpec({
    type: STEP_TYPES.LOOP_ELEMENTS,
    version: 1,
    display: { label: t('specNodeLoopElements'), iconClass: 'icon-loop', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: t('specFieldSelector'), type: 'string', required: true },
      {
        key: 'saveAs',
        label: t('specFieldListVarName'),
        type: 'string',
        default: 'elements',
      },
      { key: 'itemVar', label: t('specFieldItemVarName'), type: 'string', default: 'item' },
      { key: 'subflowId', label: t('specFieldSubflowId'), type: 'string', required: true },
    ],
    defaults: { saveAs: 'elements', itemVar: 'item' },
  });

  // SwitchFrame
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_FRAME,
    version: 1,
    display: { label: t('specNodeSwitchFrame'), iconClass: 'icon-frame', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'frame',
        label: t('specFieldFrameLocator'),
        type: 'object',
        fields: [
          { key: 'index', label: t('specFieldIndex'), type: 'number' },
          { key: 'urlContains', label: t('specFieldUrlContains'), type: 'string' },
        ],
      },
    ],
    defaults: {},
  });

  // HandleDownload
  registerNodeSpec({
    type: STEP_TYPES.HANDLE_DOWNLOAD,
    version: 1,
    display: { label: t('specNodeHandleDownload'), iconClass: 'icon-download', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'filenameContains', label: t('specFieldFilenameContains'), type: 'string' },
      {
        key: 'waitForComplete',
        label: t('specFieldWaitForComplete'),
        type: 'boolean',
        default: true,
      },
      { key: 'timeoutMs', label: t('specFieldTimeoutMs'), type: 'number', default: 60000 },
      { key: 'saveAs', label: t('specFieldSaveVar'), type: 'string' },
    ],
    defaults: { waitForComplete: true, timeoutMs: 60000, saveAs: 'download' },
  });

  // Script
  registerNodeSpec({
    type: STEP_TYPES.SCRIPT,
    version: 1,
    display: { label: t('specNodeScript'), iconClass: 'icon-script', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'world',
        label: t('specFieldWorld'),
        type: 'select',
        options: [
          { label: 'ISOLATED', value: 'ISOLATED' },
          { label: 'MAIN', value: 'MAIN' },
        ] as any,
        default: 'ISOLATED',
      },
      {
        key: 'code',
        label: t('specFieldCode'),
        type: 'string',
        widget: 'code',
        required: true,
      },
      {
        key: 'when',
        label: t('specFieldWhen'),
        type: 'select',
        options: [
          { label: 'before', value: 'before' },
          { label: 'after', value: 'after' },
        ] as any,
        default: 'after',
      },
      { key: 'assign', label: t('specFieldAssignJson'), type: 'json' },
      { key: 'saveAs', label: t('specFieldSaveVar'), type: 'string' },
    ],
    defaults: { world: 'ISOLATED', when: 'after' },
  });

  // Tabs
  registerNodeSpec({
    type: STEP_TYPES.OPEN_TAB,
    version: 1,
    display: { label: t('specNodeOpenTab'), iconClass: 'icon-openTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'url', label: 'URL', type: 'string' },
      { key: 'newWindow', label: t('specFieldNewWindow'), type: 'boolean', default: false },
    ],
    defaults: { newWindow: false },
  });
  registerNodeSpec({
    type: 'executeFlow' as any,
    version: 1,
    display: { label: t('specNodeExecuteFlow'), iconClass: 'icon-exec', category: 'Flow' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'flowId', label: t('specFieldFlowId'), type: 'string', required: true },
      { key: 'inline', label: t('specFieldInline'), type: 'boolean', default: false },
      { key: 'args', label: t('specFieldArgsJson'), type: 'json' },
    ],
    defaults: { inline: false },
  });
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_TAB,
    version: 1,
    display: { label: t('specNodeSwitchTab'), iconClass: 'icon-switchTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'tabId', label: 'TabId', type: 'number' },
      { key: 'urlContains', label: t('specFieldUrlContains'), type: 'string' },
      { key: 'titleContains', label: t('specFieldTitleContains'), type: 'string' },
    ],
    defaults: {},
  });
  registerNodeSpec({
    type: STEP_TYPES.CLOSE_TAB,
    version: 1,
    display: { label: t('specNodeCloseTab'), iconClass: 'icon-closeTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'tabIds',
        label: 'TabIds',
        type: 'array',
        item: { key: 'id', label: 'id', type: 'number' } as any,
      },
      { key: 'url', label: 'URL', type: 'string' },
    ],
    defaults: {},
  });

  // Logic
  registerNodeSpec({
    type: STEP_TYPES.IF,
    version: 1,
    display: { label: t('specNodeIf'), iconClass: 'icon-if', category: 'Logic' },
    ports: { inputs: 1, outputs: 'any' },
    schema: [
      {
        key: 'condition',
        label: t('specFieldConditionExprJson'),
        type: 'json',
        help: t('specFieldIfHelp'),
      },
      {
        key: 'branches',
        label: t('specFieldBranches'),
        type: 'array',
        item: {
          key: 'b',
          label: 'case',
          type: 'object',
          fields: [
            { key: 'id', label: 'ID', type: 'string' },
            { key: 'name', label: t('specFieldName'), type: 'string' },
            { key: 'expr', label: t('specFieldExpression'), type: 'string' },
          ],
        } as any,
      },
      { key: 'else', label: t('specFieldEnableElse'), type: 'boolean', default: true },
    ],
    defaults: { else: true },
  });
  registerNodeSpec({
    type: STEP_TYPES.FOREACH,
    version: 1,
    display: { label: t('specNodeForeach'), iconClass: 'icon-foreach', category: 'Logic' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'listVar', label: t('specFieldListVar'), type: 'string', required: true },
      { key: 'itemVar', label: t('specFieldItemVar'), type: 'string', default: 'item' },
      { key: 'subflowId', label: t('specFieldSubflowId'), type: 'string', required: true },
      {
        key: 'concurrency',
        label: t('specFieldConcurrency'),
        type: 'number',
        default: 1,
        help: t('specFieldConcurrencyHelp'),
      },
    ],
    defaults: { itemVar: 'item', concurrency: 1 },
  });
  registerNodeSpec({
    type: STEP_TYPES.WHILE,
    version: 1,
    display: { label: t('specNodeWhile'), iconClass: 'icon-while', category: 'Logic' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'condition', label: t('specFieldConditionJson'), type: 'json' },
      { key: 'subflowId', label: t('specFieldSubflowId'), type: 'string', required: true },
      { key: 'maxIterations', label: t('specFieldMaxIterations'), type: 'number', default: 100 },
    ],
    defaults: { maxIterations: 100 },
  });

  // Delay (UI-only helper)
  registerNodeSpec({
    type: STEP_TYPES.DELAY,
    version: 1,
    display: { label: t('specNodeDelay'), iconClass: 'icon-delay', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'sleep',
        label: t('specFieldDelay'),
        type: 'number',
        widget: 'duration',
        required: true,
        default: 1000,
      },
    ],
    defaults: { sleep: 1000 },
  });

  // Trigger (builder-only, flow-level node)
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER,
    version: 1,
    display: { label: t('specNodeTrigger'), iconClass: 'icon-trigger', category: 'Flow' },
    ports: { inputs: 0, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'enabled', label: t('specFieldEnabled'), type: 'boolean', default: true },
      { key: 'description', label: t('specFieldDescription'), type: 'string' },
      {
        key: 'modes',
        label: t('specFieldModes'),
        type: 'object',
        fields: [
          { key: 'manual', label: t('specModeManual'), type: 'boolean', default: true },
          { key: 'url', label: t('specModeUrl'), type: 'boolean', default: false },
          { key: 'contextMenu', label: t('specModeContextMenu'), type: 'boolean', default: false },
          { key: 'command', label: t('specModeCommand'), type: 'boolean', default: false },
          { key: 'dom', label: t('specModeDom'), type: 'boolean', default: false },
          { key: 'schedule', label: t('specModeSchedule'), type: 'boolean', default: false },
        ],
      },
      {
        key: 'url',
        label: t('specFieldUrlRules'),
        type: 'object',
        fields: [
          {
            key: 'rules',
            label: t('specFieldRuleList'),
            type: 'array',
            item: {
              key: 'rule',
              label: t('specFieldRule'),
              type: 'object',
              fields: [
                {
                  key: 'kind',
                  label: t('specFieldKind'),
                  type: 'select',
                  options: [
                    { label: 'URL', value: 'url' },
                    { label: t('specKindDomain'), value: 'domain' },
                    { label: t('specKindPath'), value: 'path' },
                  ] as any,
                  default: 'url',
                },
                { key: 'value', label: t('specFieldValue'), type: 'string' },
              ],
            } as any,
          },
        ],
      },
      {
        key: 'contextMenu',
        label: t('specModeContextMenu'),
        type: 'object',
        fields: [
          {
            key: 'title',
            label: t('specFieldTitle'),
            type: 'string',
            default: t('builderRunWorkflowMenuTitle'),
          },
          { key: 'enabled', label: t('specFieldEnabled'), type: 'boolean', default: false },
        ],
      },
      {
        key: 'command',
        label: t('specModeCommand'),
        type: 'object',
        fields: [
          { key: 'commandKey', label: t('specFieldCommandKey'), type: 'string' },
          { key: 'enabled', label: t('specFieldEnabled'), type: 'boolean', default: false },
        ],
      },
      {
        key: 'dom',
        label: t('specModeDom'),
        type: 'object',
        fields: [
          { key: 'selector', label: t('specFieldSelector'), type: 'string' },
          { key: 'appear', label: t('specFieldAppear'), type: 'boolean', default: true },
          { key: 'once', label: t('specFieldOnce'), type: 'boolean', default: true },
          { key: 'debounceMs', label: t('specFieldDebounceMs'), type: 'number', default: 800 },
          { key: 'enabled', label: t('specFieldEnabled'), type: 'boolean', default: false },
        ],
      },
      {
        key: 'schedules',
        label: t('specFieldSchedules'),
        type: 'array',
        item: {
          key: 'sched',
          label: t('specFieldSchedule'),
          type: 'object',
          fields: [
            { key: 'id', label: 'ID', type: 'string' },
            {
              key: 'type',
              label: t('specFieldType'),
              type: 'select',
              options: [
                { label: t('specScheduleOnce'), value: 'once' },
                { label: t('specScheduleInterval'), value: 'interval' },
                { label: t('specScheduleDaily'), value: 'daily' },
              ] as any,
            },
            { key: 'when', label: t('specFieldWhenIso'), type: 'string' },
            { key: 'enabled', label: t('specFieldEnabled'), type: 'boolean', default: true },
          ],
        } as any,
      },
    ],
    defaults: { enabled: true },
  });
}
