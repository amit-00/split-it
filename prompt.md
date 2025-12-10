I want to create an identity app in my django service.

The identity service is responsible for Auth and User Profiles.

Authentication will be enabled through OTP with either phone number or email. (No passwords)

We will use twilio for sending phone messages.

Use Redis for:

- Active OTP state (value & attempts)
- Cooldown between requests
- Request rate limiting per identifier
- IP rate limiting

example Redis payload for OTP:
{
"otp_hash": "<hashed_otp>",
"event_id": "<uuid-of-otpevent>",
"expires_at": "<unix_timestamp or iso8601>",
"max_attempts": 5,
"attempts": 0
}

## Models:

User {
id: uuid,
email: charfield
phone: charfield
name: charfield
def_curr: charfield
}

OtpEvent {
id: uuid,
user_id: null | fk (uuid)
channel: "email" | "password"
identifier: charfield,
purpose: "register" | "login" | "add_contact"
otp_hash: charfield,
expires_at: datetime
consumed_at: null | datetime
status: "pending" | "verified" | "expired" | "failed" | "cancelled"
attempt_count: PositiveIntField
requested_ip: GenericIpAddressField
user_agent: TextField
metadata: JsonField
created_at: datetime
updated_at: datetime
}

## Endpoints for the identity service:

Note > All endpoints in the api will prefixed with /api/<verison>/<app-name>

POST /auth/otp/request
body: {
"channel": "email" | "phone",
"identifier": <email_address> or <phone_number>
"purpose": "register" | "login" | "add_contact"
"user_id": null | uuid
}
flow:

- Validate channel, identifier, uuid
  - if purpose == "register" and channel not "phone", return 400 (only allow registration through phone)
- normalize identifier
- extract ip, user_agent
- rate limit check via Redis
  - if within cooldown limit, return 429 (too soon to request new token)
  - if within per-hour limit, return 429 (must wait to issue new tokens)
- if purpose == "add_contact", if user_id == null, return 400 (require existing user_id to update contact info)
- if purpose == "login", query for user with identifier
- if purpose == "add_contact", query for user with user_id
  - if not user, return 404 (user not found)
- generate OTP
- hash OTP
- store OtpEvent record
- store in Redis
- dispatch Celery task for send_otp_email or send_otp_phone
- return 202

POST /auth/otp/verify
body: {
"channel": "email" | "phone",
"identifier": <email_address> or <phone_number>
"purpose": "register" | "login" | "add_contact"
"user_id": null | uuid
"otp": int
}
flow:

- Validate channel, identifier, uuid
- normalize identifier
- load OTP from redis
- check expiration (defensive; TTL should handle it), if over expiry, set to expired and return 400 (OTP expired)
- check attempts, if too many attempts, set to failed and return 400 (too many failed attempts)
- uptick attempts
- compare OTP
  - if fail, write back to redis with same TTL, reflect attempts in DB, return 400 (incorrect OTP)
- mark OTP as verified, consumed_at to now, update attempts, delete from redis
- if purpose == register, create user account
- if purpose == register or login, return auth JWT
- if purpose == add_contact, update user account

GET /users
query_params: {
phone: string
}
flow:

- validate param
- if no query_param, return 400 (can only query with phone number)
- query DB for user matching phone number
- if no user, return 404
- return 200 with user record

POST /users
body: {
phone: string
}
flow:

- validate phone input
- extract country from phone
- create User record
- return user record

GET /users/<pk>
flow:

- query DB for user with pk matching <pk>
- if no user, return 404
- return 200 with user record

PUT /users/<pk>
body: {

}
