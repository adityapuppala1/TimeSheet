-- AlterTable
ALTER TABLE `SecurityFinding` MODIFY `type` ENUM('SAST', 'DAST', 'SSAT', 'SSCT', 'VAPT') NOT NULL;
