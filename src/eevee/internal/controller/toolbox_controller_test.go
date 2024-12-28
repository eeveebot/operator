package controller

import (
	"context"
	"fmt"
	"os"
	"time"

	//nolint:golint
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	eeveev1alpha1 "github.com/eeveebot/operator/api/v1alpha1"
)

var _ = Describe("Toolbox controller", func() {
	Context("Toolbox controller test", func() {

		const ToolboxName = "test-toolbox"

		ctx := context.Background()

		namespace := &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name:      ToolboxName,
				Namespace: ToolboxName,
			},
		}

		typeNamespaceName := types.NamespacedName{
			Name:      ToolboxName,
			Namespace: ToolboxName,
		}
		toolbox := &eeveev1alpha1.Toolbox{}

		BeforeEach(func() {
			By("Creating the Namespace to perform the tests")
			err := k8sClient.Create(ctx, namespace)
			Expect(err).To(Not(HaveOccurred()))

			By("Setting the Image ENV VAR which stores the Operand image")
			err = os.Setenv("TOOLBOX_IMAGE", "example.com/image:test")
			Expect(err).To(Not(HaveOccurred()))

			By("creating the custom resource for the Kind Toolbox")
			err = k8sClient.Get(ctx, typeNamespaceName, toolbox)
			if err != nil && errors.IsNotFound(err) {
				// Let's mock our custom resource at the same way that we would
				// apply on the cluster the manifest under config/samples
				toolbox := &eeveev1alpha1.Toolbox{
					ObjectMeta: metav1.ObjectMeta{
						Name:      ToolboxName,
						Namespace: namespace.Name,
					},
					Spec: eeveev1alpha1.ToolboxSpec{
						Size: 1,
					},
				}

				err = k8sClient.Create(ctx, toolbox)
				Expect(err).To(Not(HaveOccurred()))
			}
		})

		AfterEach(func() {
			By("removing the custom resource for the Kind Toolbox")
			found := &eeveev1alpha1.Toolbox{}
			err := k8sClient.Get(ctx, typeNamespaceName, found)
			Expect(err).To(Not(HaveOccurred()))

			Eventually(func() error {
				return k8sClient.Delete(context.TODO(), found)
			}, 2*time.Minute, time.Second).Should(Succeed())

			// TODO(user): Attention if you improve this code by adding other context test you MUST
			// be aware of the current delete namespace limitations.
			// More info: https://book.kubebuilder.io/reference/envtest.html#testing-considerations
			By("Deleting the Namespace to perform the tests")
			_ = k8sClient.Delete(ctx, namespace)

			By("Removing the Image ENV VAR which stores the Operand image")
			_ = os.Unsetenv("TOOLBOX_IMAGE")
		})

		It("should successfully reconcile a custom resource for Toolbox", func() {
			By("Checking if the custom resource was successfully created")
			Eventually(func() error {
				found := &eeveev1alpha1.Toolbox{}
				return k8sClient.Get(ctx, typeNamespaceName, found)
			}, time.Minute, time.Second).Should(Succeed())

			By("Reconciling the custom resource created")
			toolboxReconciler := &ToolboxReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := toolboxReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespaceName,
			})
			Expect(err).To(Not(HaveOccurred()))

			By("Checking if Deployment was successfully created in the reconciliation")
			Eventually(func() error {
				found := &appsv1.Deployment{}
				return k8sClient.Get(ctx, typeNamespaceName, found)
			}, time.Minute, time.Second).Should(Succeed())

			By("Checking the latest Status Condition added to the Toolbox instance")
			Eventually(func() error {
				if toolbox.Status.Conditions != nil &&
					len(toolbox.Status.Conditions) != 0 {
					latestStatusCondition := toolbox.Status.Conditions[len(toolbox.Status.Conditions)-1]
					expectedLatestStatusCondition := metav1.Condition{
						Type:   typeAvailableToolbox,
						Status: metav1.ConditionTrue,
						Reason: "Reconciling",
						Message: fmt.Sprintf(
							"Deployment for custom resource (%s) with %d replicas created successfully",
							toolbox.Name,
							toolbox.Spec.Size),
					}
					if latestStatusCondition != expectedLatestStatusCondition {
						return fmt.Errorf("The latest status condition added to the Toolbox instance is not as expected")
					}
				}
				return nil
			}, time.Minute, time.Second).Should(Succeed())
		})
	})
})
