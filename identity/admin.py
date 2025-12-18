from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.utils.translation import gettext_lazy as _
from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """Admin interface for the custom User model."""
    
    list_display = ('username', 'email', 'pref_curr', 'is_staff', 'is_superuser', 'date_joined')
    list_filter = ('is_staff', 'is_superuser', 'is_active', 'date_joined')
    search_fields = ('username', 'email', 'first_name', 'last_name')
    ordering = ('-date_joined',)
    
    fieldsets = (
        (None, {'fields': ('username', 'password')}),
        (_('Personal info'), {'fields': ('first_name', 'last_name', 'email', 'pref_curr')}),
        (_('Permissions'), {
            'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions'),
        }),
        (_('Important dates'), {'fields': ('last_login', 'date_joined')}),
    )
    
    add_fieldsets = (
        (None, {
            'classes': ('wide',),
            'fields': ('username', 'email', 'password1', 'password2', 'pref_curr'),
        }),
    )
    
    def get_readonly_fields(self, request, obj=None):
        """Make password field readonly for non-superusers."""
        readonly = list(super().get_readonly_fields(request, obj))
        if obj and not request.user.is_superuser:
            readonly.append('password')
        return readonly
    
    def save_model(self, request, obj, form, change):
        """Override to handle password setting for superusers only."""
        if change:
            # For existing users, only allow password changes for superusers
            if 'password' in form.changed_data and not request.user.is_superuser:
                # Don't allow non-superusers to change passwords
                return
        super().save_model(request, obj, form, change)
