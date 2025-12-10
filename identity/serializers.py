from rest_framework import serializers
from .models import User, OtpEvent
import uuid


class OtpRequestSerializer(serializers.Serializer):
    channel = serializers.ChoiceField(choices=['email', 'phone'])
    identifier = serializers.CharField(max_length=255)
    purpose = serializers.ChoiceField(choices=['register', 'login', 'verify'])
    user_id = serializers.UUIDField(required=False, allow_null=True)

    def validate(self, data):
        # Additional validation can be added here
        return data


class OtpVerifySerializer(serializers.Serializer):
    channel = serializers.ChoiceField(choices=['email', 'phone'])
    identifier = serializers.CharField(max_length=255)
    purpose = serializers.ChoiceField(choices=['register', 'login', 'verify'])
    user_id = serializers.UUIDField(required=False, allow_null=True)
    otp = serializers.CharField(max_length=10)

    def validate_otp(self, value):
        # Ensure OTP contains only digits and has reasonable length
        if not value:
            raise serializers.ValidationError("OTP is required")
        if not value.isdigit():
            raise serializers.ValidationError("OTP must contain only digits")
        if len(value) > 10:
            raise serializers.ValidationError("OTP is too long")
        # OTP length should match configured length (default 6)
        from django.conf import settings
        expected_length = getattr(settings, 'OTP_LENGTH', 6)
        if len(value) != expected_length:
            raise serializers.ValidationError(f"OTP must be {expected_length} digits")
        return value


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'email', 'phone', 'name', 'def_curr', 'created_at', 'updated_at']
        read_only_fields = ['id', 'created_at', 'updated_at']


class UserCreateSerializer(serializers.Serializer):
    phone = serializers.CharField(max_length=20)

    def validate_phone(self, value):
        if not value:
            raise serializers.ValidationError("Phone number is required")
        return value


class UserUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, required=False, allow_blank=True)
    def_curr = serializers.CharField(max_length=3, required=False, allow_blank=True)

    def validate_def_curr(self, value):
        if value and len(value) != 3:
            raise serializers.ValidationError("Currency code must be 3 characters")
        return value.upper() if value else value
