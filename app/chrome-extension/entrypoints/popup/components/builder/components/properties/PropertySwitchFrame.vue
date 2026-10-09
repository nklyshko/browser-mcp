<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderFrameUrlContainsLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.frame.urlContains"
        :placeholder="getMessage('builderFrameUrlContainsPlaceholder')"
      />
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderFrameIndexLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.frame.index"
        :placeholder="getMessage('builderFrameIndexPlaceholder')"
      />
    </div>
    <div class="text-xs text-slate-500" style="padding: 0 20px">{{
      getMessage('builderFrameHint')
    }}</div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
