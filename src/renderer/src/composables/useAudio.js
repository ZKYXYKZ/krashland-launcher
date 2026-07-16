import { ref } from 'vue'
import anduinUrl from '@/assets/anduin.mp3'

const MUTE_KEY = 'krash_audio_muted'

// Singleton : une seule instance audio partagée dans tout le launcher.
const audio = new Audio(anduinUrl)
audio.loop = true
audio.volume = 0.3

// Restaure la préférence mute de la session précédente
const storedMuted = localStorage.getItem(MUTE_KEY) === 'true'
audio.muted = storedMuted
const muted = ref(storedMuted)

export function useAudio() {
  function play() {
    audio.currentTime = 0
    audio.play().catch(() => {})
  }

  function toggleMute() {
    muted.value = !muted.value
    audio.muted = muted.value
    localStorage.setItem(MUTE_KEY, muted.value)
  }

  return { muted, play, toggleMute }
}
