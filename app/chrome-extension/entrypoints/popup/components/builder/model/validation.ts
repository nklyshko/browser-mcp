import { getMessage } from '@/utils/i18n';
import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';
import { STEP_TYPES } from '@ethanwilkins/chrome-mcp-shared-2026';

export function validateNode(n: NodeBase): string[] {
  const errs: string[] = [];
  const c: any = n.config || {};

  switch (n.type) {
    case STEP_TYPES.CLICK:
    case STEP_TYPES.DBLCLICK:
    case 'fill': {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push(getMessage('builderMissingSelectorCandidate'));
      if (n.type === 'fill' && (!('value' in c) || c.value === undefined))
        errs.push(getMessage('builderMissingInputValue'));
      break;
    }
    case STEP_TYPES.WAIT: {
      if (!c?.condition) errs.push(getMessage('builderMissingWaitCondition'));
      break;
    }
    case STEP_TYPES.ASSERT: {
      if (!c?.assert) errs.push(getMessage('builderMissingAssertCondition'));
      break;
    }
    case STEP_TYPES.NAVIGATE: {
      if (!c?.url) errs.push(getMessage('builderMissingUrl'));
      break;
    }
    case STEP_TYPES.HTTP: {
      if (!c?.url) errs.push(getMessage('builderHttpMissingUrl'));
      if (c?.assign && typeof c.assign === 'object') {
        const pathRe = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
        for (const v of Object.values(c.assign)) {
          const s = String(v);
          if (!pathRe.test(s)) errs.push(`${getMessage('builderAssignInvalidPath')}${s}`);
        }
      }
      break;
    }
    case STEP_TYPES.HANDLE_DOWNLOAD: {
      // filenameContains 可选
      break;
    }
    case STEP_TYPES.EXTRACT: {
      if (!c?.saveAs) errs.push(getMessage('builderExtractNeedSaveAs'));
      if (!c?.selector && !c?.js) errs.push(getMessage('builderExtractNeedSelectorOrJs'));
      break;
    }
    case STEP_TYPES.SWITCH_TAB: {
      if (!c?.tabId && !c?.urlContains && !c?.titleContains)
        errs.push(getMessage('builderSwitchTabNeedTarget'));
      break;
    }
    case STEP_TYPES.SCREENSHOT: {
      // selector 可空（全页/可视区），不强制
      break;
    }
    case STEP_TYPES.TRIGGER_EVENT: {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push(getMessage('builderMissingSelectorCandidate'));
      if (!String(c?.event || '').trim()) errs.push(getMessage('builderNeedEventType'));
      break;
    }
    case STEP_TYPES.IF: {
      const arr = Array.isArray(c?.branches) ? c.branches : [];
      if (arr.length === 0) errs.push(getMessage('builderNeedOneBranch'));
      for (let i = 0; i < arr.length; i++) {
        if (!String(arr[i]?.expr || '').trim())
          errs.push(
            `${getMessage('builderBranchPrefix')}${i + 1}: ${getMessage('builderBranchNeedExpr')}`,
          );
      }
      break;
    }
    case STEP_TYPES.SET_ATTRIBUTE: {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push(getMessage('builderMissingSelectorCandidate'));
      if (!String(c?.name || '').trim()) errs.push(getMessage('builderNeedAttrName'));
      break;
    }
    case STEP_TYPES.LOOP_ELEMENTS: {
      if (!String(c?.selector || '').trim()) errs.push(getMessage('builderNeedElementSelector'));
      if (!String(c?.subflowId || '').trim()) errs.push(getMessage('builderNeedSubflowId'));
      break;
    }
    case STEP_TYPES.SWITCH_FRAME: {
      // Both index/urlContains optional; empty means switch back to top frame
      break;
    }
    case STEP_TYPES.EXECUTE_FLOW: {
      if (!String(c?.flowId || '').trim()) errs.push(getMessage('builderNeedTargetFlow'));
      break;
    }
    case STEP_TYPES.CLOSE_TAB: {
      // 允许空（关闭当前标签页），不强制
      break;
    }
    case STEP_TYPES.SCRIPT: {
      // 若配置了 saveAs/assign，应提供 code
      const hasAssign = c?.assign && Object.keys(c.assign).length > 0;
      if ((c?.saveAs || hasAssign) && !String(c?.code || '').trim())
        errs.push(getMessage('builderScriptMissingCode'));
      if (hasAssign) {
        const pathRe = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
        for (const v of Object.values(c.assign || {})) {
          const s = String(v);
          if (!pathRe.test(s)) errs.push(`${getMessage('builderAssignInvalidPath')}${s}`);
        }
      }
      break;
    }
  }
  return errs;
}

export function validateFlow(nodes: NodeBase[]): {
  totalErrors: number;
  nodeErrors: Record<string, string[]>;
} {
  const nodeErrors: Record<string, string[]> = {};
  let totalErrors = 0;
  for (const n of nodes) {
    const e = validateNode(n);
    if (e.length) {
      nodeErrors[n.id] = e;
      totalErrors += e.length;
    }
  }
  return { totalErrors, nodeErrors };
}
