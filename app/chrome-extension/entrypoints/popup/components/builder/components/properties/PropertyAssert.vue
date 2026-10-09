<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderAssertConditionLabel') }}</label>
      <textarea
        class="form-textarea"
        v-model="assertJson"
        rows="4"
        placeholder='{"exists":"#id"}'
      ></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderFailurePolicyLabel') }}</label>
      <select class="form-select" v-model="(node as any).config.failStrategy">
        <option value="stop">stop</option>
        <option value="warn">warn</option>
        <option value="retry">retry</option>
      </select>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import { computed } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';

const props = defineProps<{ node: NodeBase }>();

const assertJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'assert') return '';
    try {
      return JSON.stringify((n as any).config?.assert || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'assert') return;
    try {
      (n as any).config = { ...((n as any).config || {}), assert: JSON.parse(v || '{}') };
    } catch {}
  },
});
</script>

<style scoped></style>
