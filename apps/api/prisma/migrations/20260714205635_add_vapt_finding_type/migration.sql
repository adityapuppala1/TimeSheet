-- AlterTable
ALTER TABLE `securityfinding` MODIFY `type` ENUM('SAST', 'DAST', 'SSAT', 'SSCT', 'VAPT') NOT NULL;
