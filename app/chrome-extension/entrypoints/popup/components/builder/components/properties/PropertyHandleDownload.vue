<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderFilenameContainsLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.filenameContains"
        :placeholder="getMessage('builderFilenameSubstringPlaceholder')"
      />
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderTimeoutMsLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.timeoutMs"
        :placeholder="getMessage('builderDefault60000Placeholder')"
      />
    </div>
    <div class="form-group checkbox-group">
      <label class="checkbox-label"
        ><input type="checkbox" v-model="(node as any).config.waitForComplete" />
        {{ getMessage('builderWaitForDownload') }}</label
      >
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderSaveToVarLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.saveAs"
        :placeholder="getMessage('builderDefaultDownloadPlaceholder')"
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
