package controller

import (
	"context"
	"encoding/json"
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
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/yaml"

	eeveev1alpha1 "github.com/eeveebot/operator/api/eevee/v1alpha1"
)

const connectorircFinalizer = "eevee.bot/finalizer"

const defaultImageForConnectorIrc = "ghcr.io/eeveebot/connector-irc:latest"

// Definitions to manage status conditions
const (
	// typeAvailableConnectorIrc represents the status of the Deployment reconciliation
	typeAvailableConnectorIrc = "Available"
	// typeDegradedConnectorIrc represents the status used when the custom resource is deleted and the finalizer operations are yet to occur.
	typeDegradedConnectorIrc = "Degraded"
)

// ConnectorIrcReconciler reconciles a ConnectorIrc object
type ConnectorIrcReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// The following markers are used to generate the rules permissions (RBAC) on config/rbac using controller-gen
// when the command <make manifests> is executed.
// To know more about markers see: https://book.kubebuilder.io/reference/markers.html

// +kubebuilder:rbac:groups=eevee.bot,resources=connectorircs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=eevee.bot,resources=connectorircs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=eevee.bot,resources=connectorircs/finalizers,verbs=update
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch;create;update;patch;delete

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
// - https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.21.0/pkg/reconcile
func (r *ConnectorIrcReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	// Fetch the ConnectorIrc instance
	// The purpose is check if the Custom Resource for the Kind ConnectorIrc
	// is applied on the cluster if not we return nil to stop the reconciliation
	connectorirc := &eeveev1alpha1.ConnectorIrc{}
	err := r.Get(ctx, req.NamespacedName, connectorirc)
	if err != nil {
		if apierrors.IsNotFound(err) {
			// If the custom resource is not found then it usually means that it was deleted or not created
			// In this way, we will stop the reconciliation
			log.Info("connectorirc resource not found. Ignoring since object must be deleted")
			return ctrl.Result{}, nil
		}
		// Error reading the object - requeue the request.
		log.Error(err, "Failed to get connectorirc")
		return ctrl.Result{}, err
	}

	// Let's just set the status as Unknown when no status is available
	if len(connectorirc.Status.Conditions) == 0 {
		meta.SetStatusCondition(&connectorirc.Status.Conditions, metav1.Condition{Type: typeAvailableConnectorIrc, Status: metav1.ConditionUnknown, Reason: "Reconciling", Message: "Starting reconciliation"})
		if err = r.Status().Update(ctx, connectorirc); err != nil {
			log.Error(err, "Failed to update ConnectorIrc status")
			return ctrl.Result{}, err
		}

		// Let's re-fetch the connectorirc Custom Resource after updating the status
		// so that we have the latest state of the resource on the cluster and we will avoid
		// raising the error "the object has been modified, please apply
		// your changes to the latest version and try again" which would re-trigger the reconciliation
		// if we try to update it again in the following operations
		if err := r.Get(ctx, req.NamespacedName, connectorirc); err != nil {
			log.Error(err, "Failed to re-fetch connectorirc")
			return ctrl.Result{}, err
		}
	}

	// Let's add a finalizer. Then, we can define some operations which should
	// occur before the custom resource is deleted.
	// More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers
	if !controllerutil.ContainsFinalizer(connectorirc, connectorircFinalizer) {
		log.Info("Adding Finalizer for ConnectorIrc")
		if ok := controllerutil.AddFinalizer(connectorirc, connectorircFinalizer); !ok {
			err = fmt.Errorf("finalizer for ConnectorIrc was not added")
			log.Error(err, "Failed to add finalizer for ConnectorIrc")
			return ctrl.Result{}, err
		}

		if err = r.Update(ctx, connectorirc); err != nil {
			log.Error(err, "Failed to update custom resource to add finalizer")
			return ctrl.Result{}, err
		}
	}

	// Check if the ConnectorIrc instance is marked to be deleted, which is
	// indicated by the deletion timestamp being set.
	isConnectorIrcMarkedToBeDeleted := connectorirc.GetDeletionTimestamp() != nil
	if isConnectorIrcMarkedToBeDeleted {
		if controllerutil.ContainsFinalizer(connectorirc, connectorircFinalizer) {
			log.Info("Performing Finalizer Operations for ConnectorIrc before delete CR")

			// Let's add here a status "Downgrade" to reflect that this resource began its process to be terminated.
			meta.SetStatusCondition(&connectorirc.Status.Conditions, metav1.Condition{Type: typeDegradedConnectorIrc,
				Status: metav1.ConditionUnknown, Reason: "Finalizing",
				Message: fmt.Sprintf("Performing finalizer operations for the custom resource: %s ", connectorirc.Name)})

			if err := r.Status().Update(ctx, connectorirc); err != nil {
				log.Error(err, "Failed to update ConnectorIrc status")
				return ctrl.Result{}, err
			}

			// Perform all operations required before removing the finalizer and allow
			// the Kubernetes API to remove the custom resource.
			r.doFinalizerOperationsForConnectorIrc(connectorirc)

			// TODO(user): If you add operations to the doFinalizerOperationsForConnectorIrc method
			// then you need to ensure that all worked fine before deleting and updating the Downgrade status
			// otherwise, you should requeue here.

			// Re-fetch the connectorirc Custom Resource before updating the status
			// so that we have the latest state of the resource on the cluster and we will avoid
			// raising the error "the object has been modified, please apply
			// your changes to the latest version and try again" which would re-trigger the reconciliation
			if err := r.Get(ctx, req.NamespacedName, connectorirc); err != nil {
				log.Error(err, "Failed to re-fetch connectorirc")
				return ctrl.Result{}, err
			}

			meta.SetStatusCondition(&connectorirc.Status.Conditions, metav1.Condition{Type: typeDegradedConnectorIrc,
				Status: metav1.ConditionTrue, Reason: "Finalizing",
				Message: fmt.Sprintf("Finalizer operations for custom resource %s name were successfully accomplished", connectorirc.Name)})

			if err := r.Status().Update(ctx, connectorirc); err != nil {
				log.Error(err, "Failed to update ConnectorIrc status")
				return ctrl.Result{}, err
			}

			log.Info("Removing Finalizer for ConnectorIrc after successfully perform the operations")
			if ok := controllerutil.RemoveFinalizer(connectorirc, connectorircFinalizer); !ok {
				err = fmt.Errorf("finalizer for ConnectorIrc was not removed")
				log.Error(err, "Failed to remove finalizer for ConnectorIrc")
				return ctrl.Result{}, err
			}

			if err := r.Update(ctx, connectorirc); err != nil {
				log.Error(err, "Failed to remove finalizer for ConnectorIrc")
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	var connectionsSecret *corev1.Secret
	if connectorirc.Spec.ExistingSecret != "" {
		// Use the existing secret
		connectionsSecret = &corev1.Secret{}
		err = r.Get(ctx, types.NamespacedName{Name: connectorirc.Spec.ExistingSecret, Namespace: connectorirc.Namespace}, connectionsSecret)
		if err != nil {
			log.Error(err, "Failed to fetch existing secret", connectorirc.Spec.ExistingSecret)
			return ctrl.Result{}, err
		}
	} else {
		// Create a JSON representation of the connections
		connectionsJson, err := json.Marshal(map[string]interface{}{
			"ircConnections": connectorirc.Spec.Connections,
		})
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to marshal connections to JSON: %w", err)
		}

		// Convert JSON to YAML
		connectionsYaml, err := yaml.JSONToYAML(connectionsJson)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to convert connections JSON to YAML: %w", err)
		}
		// Create a secret from the connection details
		connectionsSecret = &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name:      connectorirc.Name + "-connections-config",
				Namespace: connectorirc.Namespace,
			},
			StringData: map[string]string{
				"ircConnections.yaml": string(connectionsYaml),
			},
		}

		// Ensure the secret exists
		opResult, err := controllerutil.CreateOrUpdate(context.Background(), r.Client, connectionsSecret, func() error {
			return controllerutil.SetControllerReference(connectorirc, connectionsSecret, r.Scheme)
		})
		if err != nil {
			log.Error(err, "Failed to ensure secret is present")
			return ctrl.Result{}, err
		}
		log.Info("Ensured secret", "Operation", opResult)
	}

	// Ensure the secret exists
	opResult, err := controllerutil.CreateOrUpdate(context.Background(), r.Client, connectionsSecret, func() error {
		return controllerutil.SetControllerReference(connectorirc, connectionsSecret, r.Scheme)
	})
	if err != nil {
		log.Error(err, "Failed to ensure secret is present")
		return ctrl.Result{}, err
	}
	log.Info("Ensured secret", "Operation", opResult)

	// Check if the deployment already exists, if not create a new one
	found := &appsv1.Deployment{}
	err = r.Get(ctx, types.NamespacedName{Name: connectorirc.Name, Namespace: connectorirc.Namespace}, found)
	if err != nil && apierrors.IsNotFound(err) {
		// Define a new deployment
		dep, err := r.deploymentForConnectorIrc(connectorirc, connectionsSecret)
		if err != nil {
			log.Error(err, "Failed to define new Deployment resource for ConnectorIrc")

			// The following implementation will update the status
			meta.SetStatusCondition(&connectorirc.Status.Conditions, metav1.Condition{Type: typeAvailableConnectorIrc,
				Status: metav1.ConditionFalse, Reason: "Reconciling",
				Message: fmt.Sprintf("Failed to create Deployment for the custom resource (%s): (%s)", connectorirc.Name, err)})

			if err := r.Status().Update(ctx, connectorirc); err != nil {
				log.Error(err, "Failed to update ConnectorIrc status")
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
		// Let's return the error for the reconciliation be re-triggered again
		return ctrl.Result{}, err
	}

	// The CRD API defines that the ConnectorIrc type have a ConnectorIrcSpec.Size field
	// to set the quantity of Deployment instances to the desired state on the cluster.
	// Therefore, the following code will ensure the Deployment size is the same as defined
	// via the Size spec of the Custom Resource which we are reconciling.
	size := connectorirc.Spec.Size
	if *found.Spec.Replicas != size {
		found.Spec.Replicas = &size
		if err = r.Update(ctx, found); err != nil {
			log.Error(err, "Failed to update Deployment",
				"Deployment.Namespace", found.Namespace, "Deployment.Name", found.Name)

			// Re-fetch the connectorirc Custom Resource before updating the status
			// so that we have the latest state of the resource on the cluster and we will avoid
			// raising the error "the object has been modified, please apply
			// your changes to the latest version and try again" which would re-trigger the reconciliation
			if err := r.Get(ctx, req.NamespacedName, connectorirc); err != nil {
				log.Error(err, "Failed to re-fetch connectorirc")
				return ctrl.Result{}, err
			}

			// The following implementation will update the status
			meta.SetStatusCondition(&connectorirc.Status.Conditions, metav1.Condition{Type: typeAvailableConnectorIrc,
				Status: metav1.ConditionFalse, Reason: "Resizing",
				Message: fmt.Sprintf("Failed to update the size for the custom resource (%s): (%s)", connectorirc.Name, err)})

			if err := r.Status().Update(ctx, connectorirc); err != nil {
				log.Error(err, "Failed to update ConnectorIrc status")
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
	meta.SetStatusCondition(&connectorirc.Status.Conditions, metav1.Condition{Type: typeAvailableConnectorIrc,
		Status: metav1.ConditionTrue, Reason: "Reconciling",
		Message: fmt.Sprintf("Deployment for custom resource (%s) with %d replicas created successfully", connectorirc.Name, size)})

	if err := r.Status().Update(ctx, connectorirc); err != nil {
		log.Error(err, "Failed to update ConnectorIrc status")
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

// finalizeConnectorIrc will perform the required operations before delete the CR.
func (r *ConnectorIrcReconciler) doFinalizerOperationsForConnectorIrc(cr *eeveev1alpha1.ConnectorIrc) {
	// Note: It is not recommended to use finalizers with the purpose of deleting resources which are
	// created and managed in the reconciliation. These ones, such as the Deployment created on this reconcile,
	// are defined as dependent of the custom resource. See that we use the method ctrl.SetControllerReference.
	// to set the ownerRef which means that the Deployment will be deleted by the Kubernetes API.
	// More info: https://kubernetes.io/docs/tasks/administer-cluster/use-cascading-deletion/

	// The following implementation will raise an event
	r.Recorder.Event(cr, "Warning", "Deleting",
		fmt.Sprintf("Custom Resource %s is being deleted from the namespace %s",
			cr.Name,
			cr.Namespace))
}

// deploymentForConnectorIrc returns a ConnectorIrc Deployment object
func (r *ConnectorIrcReconciler) deploymentForConnectorIrc(
	connectorirc *eeveev1alpha1.ConnectorIrc,
	configSecret *corev1.Secret,
) (*appsv1.Deployment, error) {

	replicas := connectorirc.Spec.Size

	// Get the Operand image
	image := defaultImageForConnectorIrc
	if len(connectorirc.Spec.ContainerImage) != 0 {
		image = connectorirc.Spec.ContainerImage
	}

	// Get common labels for the deployment
	labels := labelsForConnectorIrc(connectorirc.Name, image)

	// Get the pull policy
	pullPolicy := corev1.PullIfNotPresent
	pullPolicyString := connectorirc.Spec.PullPolicy
	if pullPolicyString == "Always" {
		pullPolicy = corev1.PullAlways
	}

	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      connectorirc.Name,
			Namespace: connectorirc.Namespace,
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
												Values:   []string{"amd64", "arm64", "ppc64le", "s390x"},
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
						RunAsNonRoot: ptr.To(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Volumes: []corev1.Volume{{
						Name: "connector-irc-config",
						VolumeSource: corev1.VolumeSource{
							Secret: &corev1.SecretVolumeSource{
								SecretName: configSecret.Name,
							},
						},
					}},
					Containers: []corev1.Container{{
						Image:           image,
						Name:            "connector-irc",
						ImagePullPolicy: pullPolicy,
						// Ensure restrictive context for the container
						// More info: https://kubernetes.io/docs/concepts/security/pod-security-standards/#restricted
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             ptr.To(true),
							RunAsUser:                ptr.To(int64(1000)),
							AllowPrivilegeEscalation: ptr.To(false),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{
									"ALL",
								},
							},
						},
						Env: []corev1.EnvVar{
							{
								Name:  "IRC_CONNECTIONS_CONFIG_FILE",
								Value: "/eevee/etc/connections.yaml",
							},
						},
						VolumeMounts: []corev1.VolumeMount{
							{
								Name:      "connector-irc-config",
								MountPath: "/eevee/etc/connections.yaml",
								SubPath:   "connections.yaml",
								ReadOnly:  true,
							},
						},
					}},
				},
			},
		},
	}

	// Set the ownerRef for the Deployment
	// More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/
	if err := ctrl.SetControllerReference(connectorirc, dep, r.Scheme); err != nil {
		return nil, err
	}
	return dep, nil
}

// labelsForConnectorIrc returns the labels for selecting the resources
// More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/
func labelsForConnectorIrc(name string, image string) map[string]string {
	imageTag := strings.Split(image, ":")[1]

	return map[string]string{
		"app.kubernetes.io/name":       name,
		"app.kubernetes.io/version":    imageTag,
		"app.kubernetes.io/managed-by": "eevee-operator",
	}
}

// SetupWithManager sets up the controller with the Manager.
// The whole idea is to be watching the resources that matter for the controller.
// When a resource that the controller is interested in changes, the Watch triggers
// the controller’s reconciliation loop, ensuring that the actual state of the resource
// matches the desired state as defined in the controller’s logic.
//
// Notice how we configured the Manager to monitor events such as the creation, update,
// or deletion of a Custom Resource (CR) of the ConnectorIrc kind, as well as any changes
// to the Deployment that the controller manages and owns.
func (r *ConnectorIrcReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		// Watch the ConnectorIrc CR(s) and trigger reconciliation whenever it
		// is created, updated, or deleted
		For(&eeveev1alpha1.ConnectorIrc{}).
		Named("connectorirc").
		// Watch the Deployment managed by the ConnectorIrcReconciler. If any changes occur to the Deployment
		// owned and managed by this controller, it will trigger reconciliation, ensuring that the cluster
		// state aligns with the desired state. See that the ownerRef was set when the Deployment was created.
		Owns(&appsv1.Deployment{}).
		Complete(r)
}
