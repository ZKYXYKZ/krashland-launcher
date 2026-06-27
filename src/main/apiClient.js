import axios from 'axios'
import config from './config.js'

const { API_BASE_URL } = config

export function createApiClient(getToken) {
  const client = axios.create({
    baseURL: API_BASE_URL,
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' }
  })

  client.interceptors.request.use((cfg) => {
    const token = getToken()
    if (token) cfg.headers.Authorization = `Bearer ${token}`
    return cfg
  })

  return client
}
