ALTER TABLE "DeepSeekSetting"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'deepseek',
  ADD COLUMN "baseUrl" TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
  ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'openai-chat',
  ADD COLUMN "authMode" TEXT NOT NULL DEFAULT 'bearer';
