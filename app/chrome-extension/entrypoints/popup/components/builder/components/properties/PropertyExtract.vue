<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderElementSelectorOptionalLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.selector"
        :placeholder="getMessage('builderCssSelectorPlaceholder')"
      />
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderAttributeLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.attr"
        :placeholder="getMessage('builderAttributePlaceholder')"
      />
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderCustomJsLabel') }}</label>
      <textarea
        class="form-textarea"
        v-model="(node as any).config.js"
        rows="3"
        placeholder="return document.title"
      ></textarea>
    </div>
    <div class="form-group" :class="{ invalid: !(node as any).config?.saveAs }">
      <label class="form-label">{{ getMessage('builderSaveAsLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.saveAs"
        :placeholder="getMessage('builderVarNamePlaceholder')"
      />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
