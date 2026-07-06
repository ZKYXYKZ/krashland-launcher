import { ref } from 'vue'
import sakuraUrl from '@/assets/sakura.mp3'

// Singleton : une seule instance audio partagée dans tout le launcher.
const audio = new Audio(sakuraUrl)
audio.volume = 0.3

const muted = ref(false)

export function useAudio() {
  function play() {
    audio.currentTime = 0
    audio.play().catch(() => {})
  }

  function toggleMute() {
    muted.value = !muted.value
    audio.muted = muted.value
  }

  return { muted, play, toggleMute }
}
