<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderElementSelectorOptionalLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.selector"
        :placeholder="getMessage('builderScreenshotSelectorPlaceholder')"
      />
    </div>
    <div class="form-group checkbox-group">
      <label class="checkbox-label"
        ><input type="checkbox" v-model="(node as any).config.fullPage" />
        {{ getMessage('builderFullPageScreenshot') }}</label
      >
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderSaveAsLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.saveAs"
        :placeholder="getMessage('builderShotVarPlaceholder')"
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
