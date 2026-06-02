/*
  Warnings:

  - You are about to drop the column `user_role` on the `user` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "user" DROP COLUMN "user_role",
ADD COLUMN     "userRole" TEXT;
