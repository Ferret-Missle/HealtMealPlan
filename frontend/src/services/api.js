import axios from 'axios';
import { getAuth } from 'firebase/auth';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use(async (config) => {
  const auth = getAuth();
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 429) {
      const msg = err.response.data?.detail || '月間利用上限に達しました。BYOKプランへのアップグレードをご検討ください。';
      return Promise.reject(new Error(msg));
    }
    return Promise.reject(err);
  }
);

// Auth
export const authApi = {
  register: (data) => api.post('/api/auth/register', data),
  me: () => api.get('/api/auth/me'),
  disconnect: (service) => api.delete(`/api/auth/disconnect/${service}`),
  fitbitLoginUrl: (userId) => api.get(`/api/auth/fitbit/login?user_id=${userId}`),
  healthplanetLoginUrl: (userId) => api.get(`/api/auth/healthplanet/login?user_id=${userId}`),
  googleLoginUrl: (userId) => api.get(`/api/auth/google/login?user_id=${userId}`),
  fatsecretRequestToken: (userId) => api.get(`/api/auth/fatsecret/request-token?user_id=${userId}`),
  fatsecretAccessToken: (data) => api.post('/api/auth/fatsecret/access-token', data),
};

// Dashboard
export const dashboardApi = {
  today: (date) => api.get('/api/dashboard/today', { params: date ? { target_date: date } : {} }),
  sleep: (days = 7) => api.get('/api/dashboard/sleep', { params: { days } }),
  exerciseComparison: (days = 7) => api.get('/api/dashboard/exercise-comparison', { params: { days } }),
};

// Meals
export const mealsApi = {
  list: (date) => api.get('/api/meals/', { params: date ? { date } : {} }),
  add: (data) => api.post('/api/meals/', data),
  update: (id, data) => api.put(`/api/meals/${id}`, data),
  remove: (id) => api.delete(`/api/meals/${id}`),
  search: (q, page = 0) => api.get('/api/meals/search', { params: { q, page } }),
  foodDetail: (foodId) => api.get(`/api/meals/food/${foodId}`),
  barcode: (barcode) => api.get(`/api/meals/barcode/${barcode}`).then(r => r.data),
  history: (days = 7) => api.get('/api/meals/history', { params: { days } }).then(r => r.data),
  photoEstimate: (data) => api.post('/api/meals/photo-estimate', data).then(r => r.data),
  copy: (data) => api.post('/api/meals/copy', data).then(r => r.data),
  // FatSecret の食事ログを指定日付で同期
  syncFatSecret: (date) => api.post('/api/meals/sync-fatsecret', null, { params: { date } }).then(r => r.data),
};

// Body
export const bodyApi = {
  weightHistory: (days = 30) => api.get('/api/body/weight', { params: { days } }),
  addWeight: (data) => api.post('/api/body/weight', data),
  sync: (date) => api.post('/api/body/sync', null, { params: date ? { target_date: date } : {} }),
  goals: () => api.get('/api/body/goals'),
  updateGoals: (data) => api.put('/api/body/goals', data),
};

// Settings
export const settingsApi = {
  get: () => api.get('/api/settings/'),
  updatePreferences: (data) => api.put('/api/settings/preferences', data),
  registerApiKey: (data) => api.post('/api/settings/api-keys', data),
  deleteApiKey: (provider) => api.delete(`/api/settings/api-keys/${provider}`),
  syncCalendars: () => api.get('/api/settings/calendars/sync'),
  updateCalendar: (calendarId, data) => api.put(`/api/settings/calendars/${calendarId}`, data),
};

// Group
export const groupApi = {
  myGroup: () => api.get('/api/groups/my'),
  create: (data) => api.post('/api/groups/create', data),
  invite: (groupId, data) => api.post(`/api/groups/${groupId}/invite`, data),
  join: (token) => api.post(`/api/groups/join/${token}`),
  leave: (groupId) => api.delete(`/api/groups/${groupId}/leave`),
};

// Meal Plans
export const mealPlanApi = {
  list: () => api.get('/api/meal-plans/').then(r => r.data),
  get: (planId) => api.get(`/api/meal-plans/${planId}`).then(r => r.data),
  generate: (data) => api.post('/api/meal-plans/generate', data).then(r => r.data),
  confirm: (planId) => api.put(`/api/meal-plans/${planId}/confirm`).then(r => r.data),
  updateSlot: (planId, slotId, data) => api.put(`/api/meal-plans/${planId}/slots/${slotId}`, data).then(r => r.data),
  updateItem: (planId, itemId, data) => api.put(`/api/meal-plans/${planId}/items/${itemId}`, data).then(r => r.data),
  replaceSlot: (planId, slotId, data) => api.post(`/api/meal-plans/${planId}/slots/${slotId}/replace`, data).then(r => r.data),
  recalculate: (planId) => api.post(`/api/meal-plans/${planId}/recalculate`).then(r => r.data),
};

// Shopping
export const shoppingApi = {
  get: (planId) => api.get(`/api/shopping/${planId}`).then(r => r.data),
};

// Chat (S2-04)
export const chatApi = {
  send: (data) => api.post('/api/chat/', data).then(r => r.data),
};

export default api;
