insert into public.users (
  id,
  email,
  password_hash,
  first_name,
  last_name,
  role,
  auth_provider,
  google_subject
)
values (
  gen_random_uuid(),
  'ahmadsaleem19950@gmail.com',
  '$argon2id$v=19$m=65536,t=3,p=4$vmtoeWUlM943CduzrHK7CQ$V6JZbXCTEOyEz39DdSv4YNw9xtwah5n8wYN51P0RgAQ',
  'Ahmad',
  'Saleem',
  'admin',
  'password',
  null
)
on conflict (email) do update
set password_hash = excluded.password_hash,
    role = 'admin',
    auth_provider = 'password',
    google_subject = null,
    updated_at = now();
