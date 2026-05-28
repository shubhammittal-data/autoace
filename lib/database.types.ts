/**
 * Hand-rolled Supabase schema types.
 *
 * Regenerate with `supabase gen types typescript --project-id <id>` once you
 * apply `supabase/migrations/0001_init.sql`.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      dealers: {
        Row: {
          id: string;
          slug: string;
          name: string;
          xtime_dealer_id: string;
          xtime_dealer_code: string | null;
          timezone: string;
          phone: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          xtime_dealer_id: string;
          xtime_dealer_code?: string | null;
          timezone?: string;
          phone?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['dealers']['Insert']>;
        Relationships: [];
      };
      appointments: {
        Row: {
          id: string;
          dealer_id: string;
          retell_call_id: string | null;
          xtime_appointment_id: string | null;
          customer_phone: string | null;
          customer_email: string | null;
          customer_first_name: string | null;
          customer_last_name: string | null;
          vehicle_year: number | null;
          vehicle_make: string | null;
          vehicle_model: string | null;
          service_requested: string | null;
          service_code: string | null;
          appointment_time: string | null;
          status: 'pending' | 'confirmed' | 'failed';
          raw_payload: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          dealer_id: string;
          retell_call_id?: string | null;
          xtime_appointment_id?: string | null;
          customer_phone?: string | null;
          customer_email?: string | null;
          customer_first_name?: string | null;
          customer_last_name?: string | null;
          vehicle_year?: number | null;
          vehicle_make?: string | null;
          vehicle_model?: string | null;
          service_requested?: string | null;
          service_code?: string | null;
          appointment_time?: string | null;
          status?: 'pending' | 'confirmed' | 'failed';
          raw_payload?: Json | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['appointments']['Insert']>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
