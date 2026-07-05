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

onMounted(() => {
  const audio = new Audio('/sakura.mp3')
  audio.volume = 0.3
  audio.play().catch(() => {})
})
</script>
