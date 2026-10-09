<template>
  <div class="keys">
    <input class="form-input" :placeholder="placeholder" :value="text" @input="onInput" />
    <div class="help">{{ getMessage('builderKeySequenceExample') }}</div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';
import { ref, watchEffect } from 'vue';
const props = defineProps<{ modelValue?: string; field?: any }>();
const emit = defineEmits<{ (e: 'update:modelValue', v?: string): void }>();
const text = ref<string>(props.modelValue ?? '');
const placeholder = props.field?.placeholder || getMessage('builderKeySequenceDefault');
function onInput(ev: any) {
  const v = String(ev?.target?.value ?? '');
  text.value = v;
  emit('update:modelValue', v);
}
watchEffect(() => (text.value = props.modelValue ?? ''));
</script>
