-- VAY-1529: preserve existing canonical NULLs; explicit writes support two inclusions.
ALTER TABLE pms.rate_plans
  DROP CONSTRAINT chk_pms_rate_plans_canonical_flexible_shape,
  ADD CONSTRAINT chk_pms_rate_plans_canonical_flexible_shape
    CHECK (
      pricing_contract_version IS NULL
      OR
      (
        pricing_contract_version = 'pms-pricing.v1'
        AND rate_type = 'flexible'
        AND base_rate_amount > 0
        AND active
        AND (meal_plan IS NULL OR meal_plan IN ('room_only', 'breakfast'))
        AND payment_policy = '{}'::jsonb
        AND deposit_policy = '{}'::jsonb
        AND jsonb_typeof(cancellation_policy_snapshot) = 'object'
        AND cancellation_policy_snapshot = jsonb_build_object(
          'type', 'free_until_days_before_arrival',
          'freeCancellationDeadlineDays',
            cancellation_policy_snapshot->'freeCancellationDeadlineDays',
          'afterDeadlinePenalty', 'full_booking_amount',
          'noShowPenalty', 'full_booking_amount'
        )
        AND jsonb_typeof(
          cancellation_policy_snapshot->'freeCancellationDeadlineDays'
        ) = 'number'
        AND cancellation_policy_snapshot->>'freeCancellationDeadlineDays'
              ~ '^(0|[1-9][0-9]{0,2})$'
        AND CASE
          WHEN cancellation_policy_snapshot->>'freeCancellationDeadlineDays'
                 ~ '^(0|[1-9][0-9]{0,2})$'
          THEN (
            cancellation_policy_snapshot->>'freeCancellationDeadlineDays'
          )::INTEGER BETWEEN 0 AND 365
          ELSE FALSE
        END
      )
    );

