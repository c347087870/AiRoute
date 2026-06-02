<template>
  <div class="app-layout">
    <Sidebar />
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import Sidebar from './components/Sidebar.vue'
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'MiSans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  background: #F5F5F5;
  color: #1A1A1A;
  overflow: hidden;
  height: 100vh;
}

::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: #D0D0D0;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #B0B0B0;
}

.app-layout {
  display: flex;
  height: 100vh;
}

.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px;
}

input, select, textarea {
  background: #FFFFFF;
  border: 1px solid #E0E0E0;
  color: #1A1A1A;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

input:focus, select:focus, textarea:focus {
  border-color: #0082FC;
  box-shadow: 0 0 0 3px rgba(0, 130, 252, 0.1);
}

input::placeholder, textarea::placeholder {
  color: #B0B0B0;
}

select option {
  background: #FFFFFF;
  color: #1A1A1A;
}

select {
  appearance: auto;
}

button {
  cursor: pointer;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  transition: all 0.2s;
}

.btn-primary {
  background: #0082FC;
  color: #fff;
  padding: 8px 20px;
  font-weight: 500;
}

.btn-primary:hover {
  background: #006FDB;
}

.btn-danger {
  background: #FF3B30;
  color: #fff;
  padding: 8px 20px;
  font-weight: 500;
}

.btn-danger:hover {
  background: #E0342B;
}

.btn-ghost {
  background: #FFFFFF;
  color: #666666;
  padding: 8px 16px;
  border: 1px solid #E0E0E0;
}

.btn-ghost:hover {
  color: #0082FC;
  border-color: #0082FC;
}

.btn-sm {
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 8px;
}

.card {
  background: #FFFFFF;
  border: 1px solid #EEEEEE;
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
</style>
