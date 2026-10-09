<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderKeySequenceLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.keys"
        :placeholder="getMessage('builderKeySequencePlaceholder')"
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
