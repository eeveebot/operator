package controller

import (
	"context"
	"fmt"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	eeveev1alpha1 "github.com/eeveebot/operator/api/eevee/v1alpha1"
)

const toolboxFinalizer = "eevee.bot/finalizer"

const defaultImageForToolbox = "ghcr.io/eeveebot/toolbox:latest"

// Definitions to manage status conditions
const (
	// typeAvailableToolbox represents the status of the Deployment reconciliation
	typeAvailableToolbox = "Available"
	// typeDegradedToolbox represents the status used when the custom resource is deleted and the finalizer operations are yet to occur.
	typeDegradedToolbox = "Degraded"
)

// ToolboxReconciler reconciles a Toolbox object
type ToolboxReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// The following markers are used to generate the rules permissions (RBAC) on config/rbac using controller-gen
// when the command <make manifests> is executed.
// To know more about markers see: https://book.kubebuilder.io/reference/markers.html

// +kubebuilder:rbac:groups=*,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=*,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=eevee.bot,resources=toolboxes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=eevee.bot,resources=toolboxes/finalizers,verbs=update
// +kubebuilder:rbac:groups=eevee.bot,resources=toolboxes/status,verbs=get;update;patch

// Reconcile is part of the main kubernetes reconciliation loop which aims to
// move the current state of the cluster closer to the desired state.
// It is essential for the controller's reconciliation loop to be idempotent. By following the Operator
// pattern you will create Controllers which provide a reconcile function
// responsible for synchronizing resources until the desired state is reached on the cluster.
// Breaking this recommendation goes against the design principles of controller-runtime.
// and may lead to unforeseen consequences such as resources becoming stuck and requiring manual intervention.
// For further info:
// - About Operator Pattern: https://kubernetes.io/docs/concepts/extend-kubernetes/operator/
// - About Controllers: https://kubernetes.io/docs/concepts/architecture/controller/
// - https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.18.4/pkg/reconcile
func (r *ToolboxReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// Fetch the Toolbox instance
	// The purpose is check if the Custom Resource for the Kind Toolbox
	// is applied on the cluster if not we return nil to stop the reconciliation
	toolbox := &eeveev1alpha1.Toolbox{}
	err := r.Get(ctx, req.NamespacedName, toolbox)
	if err != nil {
		if apierrors.IsNotFound(err) {
			// If the custom resource is not found then it usually means that it was deleted or not created
			// In this way, we will stop the reconciliation
			log.Info("toolbox resource not found. Ignoring since object must be deleted")
			return ctrl.Result{}, nil
		}
		// Error reading the object - requeue the request.
		log.Error(err, "Failed to get toolbox")
		return ctrl.Result{}, err
	}

	// Let's just set the status as Unknown when no status is available
	if toolbox.Status.Conditions == nil || len(toolbox.Status.Conditions) == 0 {
		meta.SetStatusCondition(&toolbox.Status.Conditions, metav1.Condition{Type: typeAvailableToolbox, Status: metav1.ConditionUnknown, Reason: "Reconciling", Message: "Starting reconciliation"})
		if err = r.Status().Update(ctx, toolbox); err != nil {
			log.Error(err, "Failed to update Toolbox status")
			return ctrl.Result{}, err
		}

		// Let's re-fetch the toolbox Custom Resource after updating the status
		// so that we have the latest state of the resource on the cluster and we will avoid
		// raising the error "the object has been modified, please apply
		// your changes to the latest version and try again" which would re-trigger the reconciliation
		// if we try to update it again in the following operations
		if err := r.Get(ctx, req.NamespacedName, toolbox); err != nil {
			log.Error(err, "Failed to re-fetch toolbox")
			return ctrl.Result{}, err
		}
	}

	// Let's add a finalizer. Then, we can define some operations which should
	// occur before the custom resource is deleted.
	// More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers
	if !controllerutil.ContainsFinalizer(toolbox, toolboxFinalizer) {
		log.Info("Adding Finalizer for Toolbox")
		if ok := controllerutil.AddFinalizer(toolbox, toolboxFinalizer); !ok {
			log.Error(err, "Failed to add finalizer into the custom resource")
			return ctrl.Result{Requeue: true}, nil
		}

		if err = r.Update(ctx, toolbox); err != nil {
			log.Error(err, "Failed to update custom resource to add finalizer")
			return ctrl.Result{}, err
		}
	}

	// Check if the Toolbox instance is marked to be deleted, which is
	// indicated by the deletion timestamp being set.
	isToolboxMarkedToBeDeleted := toolbox.GetDeletionTimestamp() != nil
	if isToolboxMarkedToBeDeleted {
		if controllerutil.ContainsFinalizer(toolbox, toolboxFinalizer) {
			log.Info("Performing Finalizer Operations for Toolbox before delete CR")

			// Let's add here a status "Downgrade" to reflect that this resource began its process to be terminated.
			meta.SetStatusCondition(&toolbox.Status.Conditions, metav1.Condition{Type: typeDegradedToolbox,
				Status: metav1.ConditionUnknown, Reason: "Finalizing",
				Message: fmt.Sprintf("Performing finalizer operations for the custom resource: %s ", toolbox.Name)})

			if err := r.Status().Update(ctx, toolbox); err != nil {
				log.Error(err, "Failed to update Toolbox status")
				return ctrl.Result{}, err
			}

			// Perform all operations required before removing the finalizer and allow
			// the Kubernetes API to remove the custom resource.
			r.doFinalizerOperationsForToolbox(toolbox)

			// TODO(user): If you add operations to the doFinalizerOperationsForToolbox method
			// then you need to ensure that all worked fine before deleting and updating the Downgrade status
			// otherwise, you should requeue here.

			// Re-fetch the toolbox Custom Resource before updating the status
			// so that we have the latest state of the resource on the cluster and we will avoid
			// raising the error "the object has been modified, please apply
			// your changes to the latest version and try again" which would re-trigger the reconciliation
			if err := r.Get(ctx, req.NamespacedName, toolbox); err != nil {
				log.Error(err, "Failed to re-fetch toolbox")
				return ctrl.Result{}, err
			}

			meta.SetStatusCondition(&toolbox.Status.Conditions, metav1.Condition{Type: typeDegradedToolbox,
				Status: metav1.ConditionTrue, Reason: "Finalizing",
				Message: fmt.Sprintf("Finalizer operations for custom resource %s name were successfully accomplished", toolbox.Name)})

			if err := r.Status().Update(ctx, toolbox); err != nil {
				log.Error(err, "Failed to update Toolbox status")
				return ctrl.Result{}, err
			}

			log.Info("Removing Finalizer for Toolbox after successfully perform the operations")
			if ok := controllerutil.RemoveFinalizer(toolbox, toolboxFinalizer); !ok {
				log.Error(err, "Failed to remove finalizer for Toolbox")
				return ctrl.Result{Requeue: true}, nil
			}

			if err := r.Update(ctx, toolbox); err != nil {
				log.Error(err, "Failed to remove finalizer for Toolbox")
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	// Check if the deployment already exists, if not create a new one
	found := &appsv1.Deployment{}
	err = r.Get(ctx, types.NamespacedName{Name: toolbox.Name, Namespace: toolbox.Namespace}, found)
	if err != nil && apierrors.IsNotFound(err) {
		// Define a new deployment
		dep, err := r.deploymentForToolbox(toolbox)
		if err != nil {
			log.Error(err, "Failed to define new Deployment resource for Toolbox")

			// The following implementation will update the status
			meta.SetStatusCondition(&toolbox.Status.Conditions, metav1.Condition{Type: typeAvailableToolbox,
				Status: metav1.ConditionFalse, Reason: "Reconciling",
				Message: fmt.Sprintf("Failed to create Deployment for the custom resource (%s): (%s)", toolbox.Name, err)})

			if err := r.Status().Update(ctx, toolbox); err != nil {
				log.Error(err, "Failed to update Toolbox status")
				return ctrl.Result{}, err
			}

			return ctrl.Result{}, err
		}

		log.Info("Creating a new Deployment",
			"Deployment.Namespace", dep.Namespace, "Deployment.Name", dep.Name)
		if err = r.Create(ctx, dep); err != nil {
			log.Error(err, "Failed to create new Deployment",
				"Deployment.Namespace", dep.Namespace, "Deployment.Name", dep.Name)
			return ctrl.Result{}, err
		}

		// Deployment created successfully
		// We will requeue the reconciliation so that we can ensure the state
		// and move forward for the next operations
		return ctrl.Result{RequeueAfter: time.Minute}, nil
	} else if err != nil {
		log.Error(err, "Failed to get Deployment")
		// Let's return the error for the reconciliation be re-trigged again
		return ctrl.Result{}, err
	}

	// The CRD API defines that the Toolbox type have a ToolboxSpec.Size field
	// to set the quantity of Deployment instances to the desired state on the cluster.
	// Therefore, the following code will ensure the Deployment size is the same as defined
	// via the Size spec of the Custom Resource which we are reconciling.
	size := toolbox.Spec.Size
	if *found.Spec.Replicas != size {
		found.Spec.Replicas = &size
		if err = r.Update(ctx, found); err != nil {
			log.Error(err, "Failed to update Deployment",
				"Deployment.Namespace", found.Namespace, "Deployment.Name", found.Name)

			// Re-fetch the toolbox Custom Resource before updating the status
			// so that we have the latest state of the resource on the cluster and we will avoid
			// raising the error "the object has been modified, please apply
			// your changes to the latest version and try again" which would re-trigger the reconciliation
			if err := r.Get(ctx, req.NamespacedName, toolbox); err != nil {
				log.Error(err, "Failed to re-fetch toolbox")
				return ctrl.Result{}, err
			}

			// The following implementation will update the status
			meta.SetStatusCondition(&toolbox.Status.Conditions, metav1.Condition{Type: typeAvailableToolbox,
				Status: metav1.ConditionFalse, Reason: "Resizing",
				Message: fmt.Sprintf("Failed to update the size for the custom resource (%s): (%s)", toolbox.Name, err)})

			if err := r.Status().Update(ctx, toolbox); err != nil {
				log.Error(err, "Failed to update Toolbox status")
				return ctrl.Result{}, err
			}

			return ctrl.Result{}, err
		}

		// Now, that we update the size we want to requeue the reconciliation
		// so that we can ensure that we have the latest state of the resource before
		// update. Also, it will help ensure the desired state on the cluster
		return ctrl.Result{Requeue: true}, nil
	}

	// The following implementation will update the status
	meta.SetStatusCondition(&toolbox.Status.Conditions, metav1.Condition{Type: typeAvailableToolbox,
		Status: metav1.ConditionTrue, Reason: "Reconciling",
		Message: fmt.Sprintf("Deployment for custom resource (%s) with %d replicas created successfully", toolbox.Name, size)})

	if err := r.Status().Update(ctx, toolbox); err != nil {
		log.Error(err, "Failed to update Toolbox status")
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

// finalizeToolbox will perform the required operations before delete the CR.
func (r *ToolboxReconciler) doFinalizerOperationsForToolbox(cr *eeveev1alpha1.Toolbox) {
	// The following implementation will raise an event
	r.Recorder.Event(cr, "Warning", "Deleting",
		fmt.Sprintf("Custom Resource %s is being deleted from the namespace %s",
			cr.Name,
			cr.Namespace))
}

// deploymentForToolbox returns a Toolbox Deployment object
func (r *ToolboxReconciler) deploymentForToolbox(
	toolbox *eeveev1alpha1.Toolbox) (*appsv1.Deployment, error) {

	replicas := toolbox.Spec.Size

	// Get the Operand image
	image := defaultImageForToolbox
	if len(toolbox.Spec.ContainerImage) != 0 {
		image = toolbox.Spec.ContainerImage
	}

	labels := labelsForToolbox(toolbox.Name, image)

	// Get the pull policy
	pullPolicy := corev1.PullIfNotPresent
	pullPolicyString := toolbox.Spec.PullPolicy
	if pullPolicyString == "Always" {
		pullPolicy = corev1.PullAlways
	}

	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      toolbox.Name,
			Namespace: toolbox.Namespace,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: labels,
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: labels,
				},
				Spec: corev1.PodSpec{
					Affinity: &corev1.Affinity{
						NodeAffinity: &corev1.NodeAffinity{
							RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{
								NodeSelectorTerms: []corev1.NodeSelectorTerm{
									{
										MatchExpressions: []corev1.NodeSelectorRequirement{
											{
												Key:      "kubernetes.io/arch",
												Operator: "In",
												Values:   []string{"amd64", "arm64"},
											},
											{
												Key:      "kubernetes.io/os",
												Operator: "In",
												Values:   []string{"linux"},
											},
										},
									},
								},
							},
						},
					},
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: &[]bool{true}[0],
						RunAsUser:    &[]int64{1000}[0],
						RunAsGroup:   &[]int64{1000}[0],
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{{
						Image:           image,
						Name:            "toolbox",
						ImagePullPolicy: pullPolicy,
						// Ensure restrictive context for the container
						// More info: https://kubernetes.io/docs/concepts/security/pod-security-standards/#restricted
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             &[]bool{true}[0],
							AllowPrivilegeEscalation: &[]bool{false}[0],
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{
									"ALL",
								},
							},
						},
						Env: []corev1.EnvVar{
							{
								Name: "NATS_TOKEN",
								ValueFrom: &corev1.EnvVarSource{
									SecretKeyRef: &corev1.SecretKeySelector{
										LocalObjectReference: corev1.LocalObjectReference{
											Name: toolbox.Spec.NatsAuthSecret,
										},
										Key: "token",
									},
								},
							},
						},
					}},
				},
			},
		},
	}

	// Set the ownerRef for the Deployment
	// More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/
	if err := ctrl.SetControllerReference(toolbox, dep, r.Scheme); err != nil {
		return dep, err
	}
	return dep, nil
}

// labelsForToolbox returns the labels for selecting the resources
// More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/
func labelsForToolbox(name string, image string) map[string]string {
	imageTag := strings.Split(image, ":")[1]

	return map[string]string{
		"app.kubernetes.io/name":       name,
		"app.kubernetes.io/version":    imageTag,
		"app.kubernetes.io/managed-by": "eevee-operator",
	}
}

// SetupWithManager sets up the controller with the Manager.
// Note that the Deployment will be also watched in order to ensure its
// desirable state on the cluster
func (r *ToolboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		// Watch the ConnectorIrc CR(s) and trigger reconciliation whenever it
		// is created, updated, or deleted
		For(&eeveev1alpha1.Toolbox{}).
		Named("toolbox").
		// Watch the Deployment managed by the ConnectorIrcReconciler. If any changes occur to the Deployment
		// owned and managed by this controller, it will trigger reconciliation, ensuring that the cluster
		// state aligns with the desired state. See that the ownerRef was set when the Deployment was created.
		Owns(&appsv1.Deployment{}).
		Complete(r)
}
