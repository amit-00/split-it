from rest_framework import serializers
from .models import User


class UserSerializer(serializers.ModelSerializer):
    """Serializer for User model."""
    
    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 
                  'pref_curr', 'is_staff', 'is_superuser', 'date_joined', 'last_login')
        read_only_fields = ('id', 'is_staff', 'is_superuser', 'date_joined', 'last_login')
