package controller

// +kubebuilder:rbac:groups=*,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=*,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=*,resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=eevee.bot,resources=natsclusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=eevee.bot,resources=natsclusters/finalizers,verbs=update
// +kubebuilder:rbac:groups=eevee.bot,resources=natsclusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=policy,resources=poddisruptionbudgets,verbs=get;list;watch;create;update;patch;delete
