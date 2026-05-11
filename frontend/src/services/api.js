import axios from 'axios';
import { auth } from '../firebase';

const envBaseUrl = import.meta.env.VITE_API_URL?.trim();
const BASE_URL = envBaseUrl ? envBaseUrl.replace(/\/$/, "") : "";

const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use(async (config) => {
  const user = auth?.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status;
    const detail = err.response?.data?.detail;
    if (status === 429) {
      const msg = detail || '月間利用上限に達しました。BYOKプランへのアップグレードをご検討ください。';
      return Promise.reject(new Error(msg));
    }
    // バックエンドの detail メッセージがあれば e.message に乗せて返す
    if (detail) {
      const wrapped = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      wrapped.response = err.response;
      wrapped.status   = status;
      return Promise.reject(wrapped);
    }
    return Promise.reject(err);
  }
);

// Auth
export const authApi = {
	register: (data) => api.post("/api/auth/register", data),
	me: () => api.get("/api/auth/me"),
	deleteAccount: () => api.delete("/api/auth/me"),
	disconnect: (service) => api.delete(`/api/auth/disconnect/${service}`),
	fitbitLoginUrl: (userId) =>
		api.get(`/api/auth/fitbit/login?user_id=${userId}`),
	healthplanetLoginUrl: (userId) =>
		api.get(`/api/auth/healthplanet/login?user_id=${userId}`),
	healthplanetExchange: (userId, code) =>
		api.post("/api/auth/healthplanet/exchange", { user_id: userId, code }),
	googleLoginUrl: (userId) =>
		api.get(`/api/auth/google/login?user_id=${userId}`),
	fatsecretLoginUrl: (userId) =>
		api.get(`/api/auth/fatsecret/login?user_id=${userId}`),
	// 旧エンドポイント（後方互換）
	fatsecretRequestToken: (userId) =>
		api.get(`/api/auth/fatsecret/request-token?user_id=${userId}`),
	fatsecretAccessToken: (data) =>
		api.post("/api/auth/fatsecret/access-token", data),
};

// Dashboard
export const dashboardApi = {
  today: (date) => api.get('/api/dashboard/today', { params: date ? { target_date: date } : {} }),
  sleep: (days = 7) => api.get('/api/dashboard/sleep', { params: { days } }),
  exerciseComparison: (days = 7) => api.get('/api/dashboard/exercise-comparison', { params: { days } }),
  calendar: (date) => api.get('/api/dashboard/calendar', { params: date ? { date } : {} }).then(r => r.data),
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
  dailyKcal: (baseDate, days = 8) => api.get('/api/meals/daily-kcal', { params: { base_date: baseDate, days } }).then(r => r.data),
  dailyNutrition: (baseDate, days = 31) => api.get('/api/meals/daily-nutrition', { params: { base_date: baseDate, days } }).then(r => r.data),
  photoEstimate: (data) => api.post('/api/meals/photo-estimate', data).then(r => r.data),
  copy: (data) => api.post('/api/meals/copy', data).then(r => r.data),
  // FatSecret の食事ログを指定日付で同期
  syncFatSecret: (date) => api.post('/api/meals/sync-fatsecret', null, { params: { date } }).then(r => r.data),
  syncFatSecretBulk: (baseDate, days = 7) => api.post('/api/meals/sync-fatsecret-bulk', null, { params: { base_date: baseDate, days } }).then(r => r.data),
};

// Body
export const bodyApi = {
  weightHistory: (days = 30, baseDate) => api.get('/api/body/weight', { params: { days, ...(baseDate ? { base_date: baseDate } : {}) } }),
  syncWeightHistory:    (days = 30, baseDate) => api.post('/api/body/sync-weight-history', null, { params: { days, ...(baseDate ? { base_date: baseDate } : {}) } }),
  activityHistory:      (days = 7, baseDate)  => api.get('/api/body/activity-history', { params: { days, ...(baseDate ? { base_date: baseDate } : {}) } }),
  syncActivityHistory:  (days = 7, baseDate)  => api.post('/api/body/sync-activity-history', null, { params: { days, ...(baseDate ? { base_date: baseDate } : {}) } }),
  addWeight: (data) => api.post('/api/body/weight', data),
  sync: (date) => api.post('/api/body/sync', null, { params: date ? { target_date: date } : {} }),
  goals: () => api.get('/api/body/goals'),
  updateGoals: (data) => api.put('/api/body/goals', data),
};

// Settings
export const settingsApi = {
	get: () => api.get("/api/settings/"),
	updatePreferences: (data) => api.put("/api/settings/preferences", data),
	updateLlmModel: (data) => api.put("/api/settings/llm-model", data),
	updateForceFree: (data) => api.put("/api/settings/llm-force-free", data),
	getDashboard: () => api.get("/api/settings/dashboard").then(r => r.data),
	updateDashboard: (settings) => api.put("/api/settings/dashboard", { settings }),
	registerApiKey: (data) => api.post("/api/settings/api-keys", data),
	deleteApiKey: (provider) => api.delete(`/api/settings/api-keys/${provider}`),
	syncCalendars: () => api.get("/api/settings/calendars/sync"),
	updateCalendar: (calendarId, data) =>
		api.put(`/api/settings/calendars/${encodeURIComponent(calendarId)}`, data),
};

// Group
export const groupApi = {
  myGroup: () => api.get('/api/groups/my'),
  schedules: (startDate, days = 7) =>
    api.get('/api/groups/my/schedules', { params: { start_date: startDate, days } }).then(r => r.data),
  pendingInvitations: () => api.get('/api/groups/invitations/pending'),
  create: (data) => api.post('/api/groups/create', data),
  invite: (groupId, data) => api.post(`/api/groups/${groupId}/invite`, data),
  cancelInvitation: (groupId, inviteId) =>
    api.delete(`/api/groups/${groupId}/invitations/${inviteId}`),
  transferOwner: (groupId, targetUserId) =>
    api.put(`/api/groups/${groupId}/transfer-owner/${targetUserId}`),
  join: (token) => api.post(`/api/groups/join/${token}`),
  leave: (groupId) => api.delete(`/api/groups/${groupId}/leave`),
  getSharedSettings: () => api.get('/api/groups/my/shared-settings').then(r => r.data),
  updateSharedSettings: (settings) => api.put('/api/groups/my/shared-settings', { settings }),
};

// Meal Plans
export const mealPlanApi = {
	list: () => api.get("/api/meal-plans/").then((r) => r.data),
	get: (planId) => api.get(`/api/meal-plans/${planId}`).then((r) => r.data),
	generate: (data) =>
		api.post("/api/meal-plans/generate", data).then((r) => r.data),
	updateSlot: (planId, slotId, data) =>
		api
			.put(`/api/meal-plans/${planId}/slots/${slotId}`, data)
			.then((r) => r.data),
	updateItem: (planId, itemId, data) =>
		api
			.put(`/api/meal-plans/${planId}/items/${itemId}`, data)
			.then((r) => r.data),
	updateItemFeedback: (planId, itemId, data) =>
		api
			.put(`/api/meal-plans/${planId}/items/${itemId}/feedback`, data)
			.then((r) => r.data),
	replaceSlot: (planId, slotId, data) =>
		api
			.post(`/api/meal-plans/${planId}/slots/${slotId}/replace`, data)
			.then((r) => r.data),
	replaceDay: (planId, dayId, data) =>
		api
			.post(`/api/meal-plans/${planId}/days/${dayId}/replace`, data)
			.then((r) => r.data),
	recalculate: (planId) =>
		api.post(`/api/meal-plans/${planId}/recalculate`).then((r) => r.data),
	delete: (planId) =>
		api.delete(`/api/meal-plans/${planId}/delete`).then((r) => r.data),
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
