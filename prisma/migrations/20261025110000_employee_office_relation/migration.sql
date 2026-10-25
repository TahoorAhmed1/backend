-- Add an optional office assignment for each employee; multiple employees can share an office.
ALTER TABLE "Employee" ADD COLUMN "officeId" TEXT;

CREATE INDEX "Employee_officeId_idx" ON "Employee"("officeId");

ALTER TABLE "Employee"
ADD CONSTRAINT "Employee_officeId_fkey"
FOREIGN KEY ("officeId") REFERENCES "Office"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
