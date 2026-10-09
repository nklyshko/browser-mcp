<template>
  <div>
    <SelectorEditor
      :node="node"
      :allowPick="true"
      :title="getMessage('builderStartSelectorTitle')"
      targetKey="start"
    />
    <SelectorEditor
      :node="node"
      :allowPick="true"
      :title="getMessage('builderEndSelectorTitle')"
      targetKey="end"
    />
    <div class="hint">
      <small>{{ getMessage('builderDragPathHint') }}</small>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';
import SelectorEditor from './SelectorEditor.vue';

defineProps<{ node: NodeBase }>();
</script>

<style scoped>
.hint {
  color: #64748b;
  margin-top: 8px;
}
</style>
