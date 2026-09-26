-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "isStream" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requestPreview" TEXT,
ADD COLUMN     "responsePreview" TEXT;
