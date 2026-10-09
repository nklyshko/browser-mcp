<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderWhileConditionLabel') }}</label>
      <textarea
        class="form-textarea"
        v-model="whileJson"
        rows="3"
        placeholder='{"expression":"workflow.count < 3"}'
      ></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderSubflowIdLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.subflowId"
        :placeholder="getMessage('builderSubflowPlaceholder')"
      />
      <button class="btn-sm" style="margin-top: 8px" @click="onCreateSubflow">{{
        getMessage('builderNewSubflowButton')
      }}</button>
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderMaxIterationsLabel') }}</label>
      <input
        class="form-input"
        type="number"
        min="0"
        v-model.number="(node as any).config.maxIterations"
      />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import { computed } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';

const props = defineProps<{ node: NodeBase }>();
const emit = defineEmits<{ (e: 'create-subflow', id: string): void }>();

const whileJson = computed({
  get() {
    try {
      return JSON.stringify((props.node as any).config?.condition || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    try {
      (props.node as any).config = {
        ...((props.node as any).config || {}),
        condition: JSON.parse(v || '{}'),
      };
    } catch {}
  },
});

function onCreateSubflow() {
  const id = prompt(getMessage('builderNewSubflowPrompt'));
  if (!id) return;
  emit('create-subflow', id);
  const n = props.node as any;
  if (n && n.config) n.config.subflowId = id;
}
</script>

<style scoped></style>
