import type { HouseholdId } from '../ids';
import type { WaiverRecord } from '../entities';

export interface WaiverProvider {
  createSigningSession(input: {
    householdId: HouseholdId;
    participantName: string;
    returnUrl: string;
  }): Promise<{ signingUrl: string; providerReference: string }>;
  getWaiver(input: { providerReference: string }): Promise<WaiverRecord | null>;
  downloadDocument(input: { providerReference: string }): Promise<Uint8Array>;
}
