<template>
  <div class="flex items-center gap-2">
    <!-- Spiral icon: only while running/starting, and only if the parent has not hidden it -->
    <svg
      v-if="isRunning && !hideIcon"
      class="loading-scribble w-4 h-4 flex-shrink-0"
      viewBox="0 0 100 100"
      fill="none"
    >
      <path
        d="M50 50 C50 48, 52 46, 54 46 C58 46, 60 50, 60 54 C60 60, 54 64, 48 64 C40 64, 36 56, 36 48 C36 38, 44 32, 54 32 C66 32, 74 42, 74 54 C74 68, 62 78, 48 78 C32 78, 22 64, 22 48 C22 30, 36 18, 54 18 C74 18, 88 34, 88 54 C88 76, 72 92, 50 92"
        stroke="var(--ac-accent, #D97757)"
        stroke-width="3"
        stroke-linecap="round"
      />
    </svg>

    <!-- Shimmering label while running, plain label otherwise -->
    <span
      class="text-xs italic"
      :class="{ 'text-shimmer': isRunning }"
      :style="{ color: isRunning ? undefined : 'var(--ac-text-muted)' }"
    >
      {{ displayText }}
    </span>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';
import { getRandomLoadingText } from '../../../utils/loading-texts';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'status' }>;
  /** Hide the loading icon (when parent component displays it in timeline node position) */
  hideIcon?: boolean;
}>();

// Whether the step is currently running
const isRunning = computed(
  () => props.item.status === 'running' || props.item.status === 'starting',
);

// Random quip, used only while running
const randomText = ref(getRandomLoadingText());

// Timeout id for the quip rotation
let timeoutId: ReturnType<typeof setTimeout> | null = null;

// Previous running state, so we can tell a real transition from a re-render
let wasRunning = false;

// Start the rotation timer
function startInterval(): void {
  if (timeoutId) return;
  // Rotate the quip on a random 5-8 second interval
  const scheduleNext = () => {
    timeoutId = setTimeout(
      () => {
        randomText.value = getRandomLoadingText();
        scheduleNext();
      },
      5000 + Math.random() * 3000,
    );
  };
  scheduleNext();
}

// Stop the rotation timer
function stopInterval(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

// Watch the running state, acting only on a genuine change
watch(isRunning, (running) => {
  // Only pick a fresh quip and start the timer on the not-running -> running edge
  if (running && !wasRunning) {
    randomText.value = getRandomLoadingText();
    startInterval();
  } else if (!running && wasRunning) {
    stopInterval();
  }
  wasRunning = running;
});

// Initial setup
onMounted(() => {
  wasRunning = isRunning.value;
  if (isRunning.value) {
    startInterval();
  }
});

onUnmounted(() => {
  stopInterval();
});

// Default label for non-running states
const defaultText = computed(() => {
  switch (props.item.status) {
    case 'completed':
      return 'Done';
    case 'error':
      return 'Error';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Ready';
  }
});

// The label actually rendered
const displayText = computed(() => {
  if (isRunning.value) {
    return randomText.value;
  }
  return props.item.text || defaultText.value;
});
</script>
