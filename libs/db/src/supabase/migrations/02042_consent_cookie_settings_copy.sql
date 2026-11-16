-- 02042: copy for the public footer's "Cookie settings" control and the reopened consent banner.
--
-- Data only. Append-only, forward-only, idempotent: two new UI keys in English and Québec French,
-- inserted with ON CONFLICT DO NOTHING (02015's pattern), so a re-run, or a key an operator already
-- added, changes nothing. No table, view, sequence or function is created, so no grant is needed.
--
-- Once a visitor had answered the Law 25 consent banner (components/privacy/ConsentBanner.tsx), they
-- could not change their choice. The footer now carries a "Cookie settings" button
-- (components/privacy/CookieSettingsButton.tsx) that reopens the banner with the stored choice
-- checked. Until this runs, useLabel() shows the same copy built in (components/privacy/consent-copy.ts,
-- which ConsentSettings.test.tsx holds to this file). The banner's close button reuses `close` (02015).

INSERT INTO public.translations (key, translations, created_at, updated_at)
VALUES
  ('privacy.consent.cookie_settings', '{"en":"Cookie settings","fr":"Paramètres des témoins"}'::jsonb, now(), now()),
  ('privacy.consent.current_choice', '{"en":"Your current choice is shown below. You can change it at any time.","fr":"Votre choix actuel est indiqué ci-dessous. Vous pouvez le modifier en tout temps."}'::jsonb, now(), now())
ON CONFLICT (key) DO NOTHING;
