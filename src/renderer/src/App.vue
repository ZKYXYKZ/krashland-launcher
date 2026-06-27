<template>
  <TitleBar />

  <div v-if="checkingSession" class="boot-screen">
    <span class="spinner" />
  </div>

  <LoginView v-else-if="!user" @logged-in="onLoggedIn" />

  <MainView v-else :user="user" @logged-out="onLoggedOut" />

  <UpdateBanner />
</template>

<script setup>
import { ref, onMounted } from 'vue'
import TitleBar from '@/components/TitleBar.vue'
import LoginView from '@/views/LoginView.vue'
import MainView from '@/views/MainView.vue'
import UpdateBanner from '@/components/UpdateBanner.vue'

const user = ref(null)
const checkingSession = ref(true)

function onLoggedIn(u) { user.value = u }
function onLoggedOut() { user.value = null }

onMounted(async () => {
  const res = await window.krash.auth.me()
  if (res.ok) user.value = res.user
  checkingSession.value = false
})
</script>

<style scoped>
.boot-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-void);
}
.spinner {
  width: 36px; height: 36px;
  border: 2px solid var(--border);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
