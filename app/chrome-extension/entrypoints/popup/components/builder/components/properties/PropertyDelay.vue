<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderDelayMsLabel') }}</label>
      <input class="form-input" type="number" v-model.number="(node as any).config.ms" min="0" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
