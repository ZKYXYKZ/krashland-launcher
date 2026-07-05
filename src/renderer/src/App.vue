<template>
  <TitleBar />

  <MainView />

  <UpdateBanner />
</template>

<script setup>
import { onMounted } from 'vue'
import TitleBar from '@/components/TitleBar.vue'
import MainView from '@/views/MainView.vue'
import UpdateBanner from '@/components/UpdateBanner.vue'

import sakuraUrl from '@/assets/sakura.mp3'

onMounted(() => {
  const audio = new Audio(sakuraUrl)
  audio.volume = 0.3
  audio.play().catch(() => {})
})
</script>
