import { IsIn } from 'class-validator';

export class ReviewWithdrawalDto {
  @IsIn(['APPROVE', 'REJECT'])
  action!: 'APPROVE' | 'REJECT';
}
