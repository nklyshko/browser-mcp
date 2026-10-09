<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderElementSelectorLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.selector"
        :placeholder="getMessage('builderCssSelectorPlaceholder')"
      />
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderListVarNameLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.saveAs"
        :placeholder="getMessage('builderDefaultElementsPlaceholder')"
      />
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderItemVarLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.itemVar"
        :placeholder="getMessage('builderDefaultItemPlaceholder')"
      />
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
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';

const props = defineProps<{ node: NodeBase }>();
const emit = defineEmits<{ (e: 'create-subflow', id: string): void }>();

function onCreateSubflow() {
  const id = prompt(getMessage('builderNewSubflowPrompt'));
  if (!id) return;
  emit('create-subflow', id);
  const n = props.node as any;
  if (n && n.config) n.config.subflowId = id;
}
</script>

<style scoped></style>
