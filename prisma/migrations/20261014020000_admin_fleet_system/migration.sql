-- AlterTable
ALTER TABLE "User" ADD COLUMN     "displayUsername" TEXT,
ADD COLUMN     "username" TEXT;

-- AlterTable
ALTER TABLE "SiteState" ADD COLUMN     "instanceId" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
ADD COLUMN     "registrationOpenOverride" BOOLEAN;

-- CreateTable
CREATE TABLE "FleetPairingToken" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetPairingToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetGrant" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "controllerInstanceId" TEXT NOT NULL,
    "controllerSiteId" TEXT NOT NULL,
    "controllerUrl" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetConnection" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "remoteUrl" TEXT NOT NULL,
    "remoteInstanceId" TEXT NOT NULL,
    "remoteSiteId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "credentialCiphertext" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSnapshot" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemUpdateCheck" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "status" TEXT NOT NULL DEFAULT 'unchecked',
    "payloadJson" JSONB,
    "checkedAt" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "lockId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemUpdateCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FleetPairingToken_tokenHash_key" ON "FleetPairingToken"("tokenHash");

-- CreateIndex
CREATE INDEX "FleetPairingToken_expiresAt_idx" ON "FleetPairingToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetGrant_credentialHash_key" ON "FleetGrant"("credentialHash");

-- CreateIndex
CREATE INDEX "FleetGrant_revokedAt_idx" ON "FleetGrant"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetConnection_remoteUrl_key" ON "FleetConnection"("remoteUrl");

-- CreateIndex
CREATE INDEX "FleetConnection_status_idx" ON "FleetConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

