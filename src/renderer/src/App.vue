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
import { useAudio } from '@/composables/useAudio'

const { play } = useAudio()

onMounted(() => play())
</script>
