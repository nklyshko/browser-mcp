<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderCodeLabel') }}</label>
      <textarea
        class="form-textarea"
        v-model="(node as any).config.code"
        rows="6"
        placeholder="// your JS code"
      ></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderRuntimeLabel') }}</label>
      <select class="form-select" v-model="(node as any).config.world">
        <option value="ISOLATED">ISOLATED</option>
        <option value="MAIN">MAIN</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderTimingLabel') }}</label>
      <select class="form-select" v-model="(node as any).config.when">
        <option value="before">before</option>
        <option value="after">after</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderSaveAsOptionalLabel') }}</label>
      <input
        class="form-input"
        v-model="(node as any).config.saveAs"
        :placeholder="getMessage('builderVarNamePlaceholder')"
      />
    </div>
    <div class="form-group">
      <label class="form-label">{{ getMessage('builderResultMappingLabel') }}</label>
      <KeyValueEditor v-model="(node as any).config.assign" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';

import type { NodeBase } from '@/entrypoints/background/record-replay-v3/builder-types';
import KeyValueEditor from '@/entrypoints/popup/components/builder/components/KeyValueEditor.vue';

defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
